import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import {
  createGitHubTransport, createTunnelFetch, describeTransportError, discoverGitHubProxy, isLoopbackHost,
  isTransportFailure, parseWindowsProxy, proxyBypassesHost, proxyFromEnvironment, readWindowsProxySettings,
  type MnemonGitHubProxyRoute,
} from '../src/host/github-transport.ts'

const PROXY = 'http://127.0.0.1:7890'

/** The failure undici reports when a connection never happens. */
function transportError(message = 'fetch failed', code = 'UND_ERR_CONNECT_TIMEOUT'): Error {
  return Object.assign(new Error(message), { cause: Object.assign(new Error('Connect Timeout Error'), { code }) })
}

function answering(handler: (url: string) => Response | Promise<Response>): { calls: string[]; request: typeof fetch } {
  const calls: string[] = []
  const request = (async (input: RequestInfo | URL) => {
    calls.push(String(input))
    return handler(String(input))
  }) as unknown as typeof fetch
  return { calls, request }
}

function route(proxy = PROXY, source: 'environment' | 'system' = 'environment', bypass?: string): MnemonGitHubProxyRoute {
  return { proxy: { url: proxy, source }, ...(bypass === undefined ? {} : { bypass }) }
}

describe('the proxy a GitHub request may fall back to', () => {
  it('reads the environment the way undici does, lowercase first', () => {
    expect(proxyFromEnvironment({ HTTPS_PROXY: PROXY })?.proxy).toEqual({ url: PROXY + '/', source: 'environment' })
    expect(proxyFromEnvironment({ https_proxy: PROXY, HTTPS_PROXY: 'http://127.0.0.1:1080' })?.proxy.url).toBe(PROXY + '/')
    expect(proxyFromEnvironment({ http_proxy: PROXY })?.proxy.url).toBe(PROXY + '/')
    expect(proxyFromEnvironment({ all_proxy: PROXY })?.proxy.url).toBe(PROXY + '/')
    expect(proxyFromEnvironment({ HTTPS_PROXY: PROXY, no_proxy: 'localhost,.corp' })?.bypass).toBe('localhost,.corp')
    expect(proxyFromEnvironment({ HTTPS_PROXY: PROXY, NO_PROXY: 'localhost' })?.bypass).toBe('localhost')
    expect(proxyFromEnvironment({})).toBeUndefined()
    expect(proxyFromEnvironment({ HTTPS_PROXY: '   ' })).toBeUndefined()
    expect(proxyFromEnvironment({ HTTPS_PROXY: 'socks5://127.0.0.1:1080' })).toBeUndefined()
    expect(proxyFromEnvironment({ HTTPS_PROXY: '127.0.0.1:7890' })?.proxy.url).toBe(PROXY + '/')
  })

  it('reads the two shapes Windows writes for its proxy', () => {
    expect(parseWindowsProxy('0x1', '127.0.0.1:7890')).toEqual({ url: PROXY + '/', source: 'system' })
    expect(parseWindowsProxy(undefined, '127.0.0.1:7890')).toEqual({ url: PROXY + '/', source: 'system' })
    expect(parseWindowsProxy('0x1', 'http=127.0.0.1:1080;https=127.0.0.1:7890')).toEqual({ url: PROXY + '/', source: 'system' })
    expect(parseWindowsProxy('0x1', 'http=127.0.0.1:1080')).toEqual({ url: 'http://127.0.0.1:1080/', source: 'system' })
    expect(parseWindowsProxy('0x0', '127.0.0.1:7890')).toBeUndefined()
    expect(parseWindowsProxy('0x1', '')).toBeUndefined()
    expect(parseWindowsProxy('0x1', undefined)).toBeUndefined()
    expect(parseWindowsProxy('0x1', 'ftp=127.0.0.1:21')).toBeUndefined()
  })

  it('reads the current user settings through reg.exe and keeps its bypass list', () => {
    const output = [
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '    ProxyEnable    REG_DWORD    0x1',
      '    ProxyServer    REG_SZ    127.0.0.1:7890',
      '    ProxyOverride    REG_SZ    localhost;127.*;<local>',
      '',
    ].join('\r\n')
    const settings = readWindowsProxySettings(() => output)
    expect(settings?.proxy).toEqual({ url: PROXY + '/', source: 'system' })
    expect(settings?.bypass).toBe('localhost;127.*;<local>')
    expect(readWindowsProxySettings(() => '    ProxyEnable    REG_DWORD    0x0')).toBeUndefined()
    expect(readWindowsProxySettings(() => { throw new Error('reg.exe is unavailable') })).toBeUndefined()
    expect(readWindowsProxySettings(() => 'nothing useful here')).toBeUndefined()
  })

  it('falls back to the system settings only where the platform has them', () => {
    const windowsSettings = (): MnemonGitHubProxyRoute | undefined => route('http://127.0.0.1:7891/', 'system')
    expect(discoverGitHubProxy({ environment: {}, platform: 'win32', windowsSettings })?.proxy.url).toBe('http://127.0.0.1:7891/')
    expect(discoverGitHubProxy({ environment: { HTTPS_PROXY: PROXY }, platform: 'win32', windowsSettings })?.proxy.url).toBe(PROXY + '/')
    expect(discoverGitHubProxy({ environment: {}, platform: 'linux', windowsSettings })).toBeUndefined()
    expect(discoverGitHubProxy({ environment: {}, platform: 'win32', windowsSettings: () => { throw new Error('no registry') } })).toBeUndefined()
  })

  it('honours a bypass list, a wildcard and the local names', () => {
    expect(proxyBypassesHost('localhost,127.*', 'localhost')).toBe(true)
    expect(proxyBypassesHost('localhost,127.*', '127.0.0.1')).toBe(true)
    expect(proxyBypassesHost('*.corp.example', 'git.corp.example')).toBe(true)
    expect(proxyBypassesHost('example.com', 'example.com')).toBe(true)
    expect(proxyBypassesHost('a.com;b.com c.com', 'b.com')).toBe(true)
    expect(proxyBypassesHost('*', 'github.com')).toBe(true)
    expect(proxyBypassesHost('<local>', 'intranet')).toBe(true)
    expect(proxyBypassesHost('<local>', 'github.com')).toBe(false)
    expect(proxyBypassesHost('*.githubusercontent.com', 'api.github.com')).toBe(false)
    expect(proxyBypassesHost(undefined, 'github.com')).toBe(false)
  })

  it('tells a connection that never happened from an answer that came back', () => {
    expect(isTransportFailure(transportError())).toBe(true)
    expect(isTransportFailure(new Error('fetch failed'))).toBe(true)
    expect(isTransportFailure(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBe(true)
    expect(isTransportFailure(new Error('socket hang up'))).toBe(true)
    expect(isTransportFailure(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))).toBe(false)
    expect(isTransportFailure(Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' }))).toBe(false)
    expect(isTransportFailure(new Error('the GitHub device code request failed: rate_limited'))).toBe(false)
    expect(isTransportFailure(undefined)).toBe(false)
    expect(isTransportFailure('fetch failed')).toBe(true)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('[::1]')).toBe(true)
    expect(isLoopbackHost('github.com')).toBe(false)
  })

  it('names the reason undici hid in cause when it reports a failure', () => {
    expect(describeTransportError(transportError())).toBe('fetch failed: Connect Timeout Error (UND_ERR_CONNECT_TIMEOUT)')
    expect(describeTransportError(new Error('fetch failed'))).toBe('fetch failed')
    expect(describeTransportError('plain text')).toBe('plain text')
  })
})

describe('the request the GitHub channel sends', () => {
  it('uses the ambient request while it works and never looks for a proxy', async () => {
    const ambient = answering(() => new Response('{"device_code":"d"}', { status: 200 }))
    const discover = vi.fn(() => route())
    const request = createGitHubTransport({ ambient: ambient.request, discover, tunnel: () => { throw new Error('no tunnel expected') } })
    const response = await request('https://github.com/login/device/code')
    expect(response.status).toBe(200)
    expect(ambient.calls).toEqual(['https://github.com/login/device/code'])
    expect(discover).not.toHaveBeenCalled()
  })

  it('retries through the discovered proxy after a connection that never happened, then keeps using it', async () => {
    const ambient = answering(() => { throw transportError() })
    const tunnel = answering(() => new Response('{"device_code":"d"}', { status: 200 }))
    const request = createGitHubTransport({ ambient: ambient.request, discover: () => route(), tunnel: () => tunnel.request })
    expect((await request('https://github.com/login/device/code')).status).toBe(200)
    expect(ambient.calls).toHaveLength(1)
    expect(tunnel.calls).toEqual(['https://github.com/login/device/code'])
    expect((await request('https://github.com/login/oauth/access_token')).status).toBe(200)
    expect(ambient.calls).toHaveLength(1)
    expect(tunnel.calls).toHaveLength(2)
  })

  it('falls back to the ambient request once the remembered proxy stops working', async () => {
    let throughProxy = true
    const ambient = answering(() => { throw transportError() })
    const tunnel = (async (input: RequestInfo | URL) => {
      if (throughProxy) return new Response('{}', { status: 200 })
      throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    }) as unknown as typeof fetch
    const request = createGitHubTransport({ ambient: ambient.request, discover: () => route(), tunnel: () => tunnel })
    expect((await request('https://github.com/login/device/code')).status).toBe(200)
    throughProxy = false
    await expect(request('https://github.com/login/oauth/access_token')).rejects.toThrow('could not reach github.com')
    // The dead proxy is forgotten: the next request starts from the ambient one again.
    expect(ambient.calls).toHaveLength(2)
  })

  it('reports what the environment is missing when no proxy is configured at all', async () => {
    const ambient = answering(() => { throw transportError() })
    const request = createGitHubTransport({ ambient: ambient.request, discover: () => undefined, tunnel: () => { throw new Error('no tunnel expected') } })
    await expect(request('https://github.com/login/device/code')).rejects.toThrow(
      'could not reach github.com: fetch failed: Connect Timeout Error (UND_ERR_CONNECT_TIMEOUT); '
      + 'this Host has no proxy for GitHub, so set HTTPS_PROXY to a proxy that can reach it',
    )
  })

  it('reports which proxy failed and why when the proxy itself cannot reach GitHub', async () => {
    const ambient = answering(() => { throw transportError() })
    const tunnel = answering(() => { throw Object.assign(new Error('the proxy refused the tunnel with HTTP 502')) })
    const request = createGitHubTransport({ ambient: ambient.request, discover: () => route(), tunnel: () => tunnel.request })
    await expect(request('https://github.com/login/device/code')).rejects.toThrow(
      'could not reach github.com: fetch failed: Connect Timeout Error (UND_ERR_CONNECT_TIMEOUT); '
      + 'the environment proxy ' + PROXY + ' could not reach it either: the proxy refused the tunnel with HTTP 502',
    )
  })

  it('keeps a host the proxy is told to bypass on the ambient request', async () => {
    const ambient = answering(() => { throw transportError() })
    const discover = vi.fn(() => route(PROXY, 'environment', '*.github.com'))
    const request = createGitHubTransport({ ambient: ambient.request, discover, tunnel: () => { throw new Error('no tunnel expected') } })
    await expect(request('https://api.github.com/user')).rejects.toThrow('the proxy ' + PROXY + ' is configured to bypass api.github.com')
    expect(ambient.calls).toHaveLength(1)
  })

  it('never retries a request to this machine, an answer that came back, or an aborted one', async () => {
    const loopback = createGitHubTransport({
      ambient: answering(() => { throw transportError() }).request,
      discover: () => { throw new Error('no discovery expected') },
      tunnel: () => { throw new Error('no tunnel expected') },
    })
    await expect(loopback('http://127.0.0.1:9/status')).rejects.toThrow('fetch failed')

    const refused = answering(() => new Response('{"error":"rate_limited"}', { status: 403 }))
    const discover = vi.fn(() => route())
    const answered = createGitHubTransport({ ambient: refused.request, discover, tunnel: () => { throw new Error('no tunnel expected') } })
    expect((await answered('https://github.com/login/device/code')).status).toBe(403)
    expect(discover).not.toHaveBeenCalled()

    const aborted = createGitHubTransport({
      ambient: answering(() => { throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }) }).request,
      discover: () => { throw new Error('no discovery expected') },
      tunnel: () => { throw new Error('no tunnel expected') },
    })
    await expect(aborted('https://github.com/login/device/code')).rejects.toThrow('This operation was aborted')
  })
})

describe('the CONNECT tunnel a fallback proxy is reached through', () => {
  it('asks the proxy for the authority of the real host and reports a refusal', async () => {
    const seen: string[] = []
    const proxy = createServer(socket => {
      socket.once('data', chunk => {
        seen.push(chunk.toString('utf8'))
        socket.end('HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n')
      })
    })
    await new Promise<void>(resolve => { proxy.listen(0, '127.0.0.1', resolve) })
    const port = (proxy.address() as AddressInfo).port
    try {
      const request = createTunnelFetch({ url: 'http://127.0.0.1:' + String(port), source: 'environment' })
      await expect(request('https://example.test/some/path')).rejects.toThrow('the proxy refused the tunnel with HTTP 502')
      expect(seen).toHaveLength(1)
      expect(seen[0]?.split('\r\n')[0]).toBe('CONNECT example.test:443 HTTP/1.1')
      expect(seen[0]).toContain('host: example.test:443')
    } finally {
      await new Promise<void>(resolve => { proxy.close(() => { resolve() }) })
    }
  })

  it('refuses an address that is not a proxy', () => {
    expect(() => createTunnelFetch({ url: 'not a url', source: 'system' })).toThrow('the proxy address could not be read: not a url')
  })
})
