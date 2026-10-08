// Browser half: a "插件配置" Settings section that shows dsh-mnemon's
// Plugins-page configuration the way a shell with its own settings page does.
// It mirrors the registered `plugins.bundle.config` entry into a slot of its
// own (same component, locale and inject) and renders it there. DSH's
// renderer binds the services as usual, but the mirrored entry declares no
// children, so the page receives no renderSlot, as in issue #340.
window.__ModuleLoader__.load({
  id: 'mnemon-settings-embed-fixture',
  factory: (require) => {
    var module = { exports: {} }
    var React = require('react')
    var SLOT = 'fixture.plugin.config'
    function apply(ctx) {
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section', id: 'plugin-configuration-fixture', order: 16, label: function () { return '插件配置' },
          children: { 'fixture.plugin.config': { kind: 'keyed', scope: 'root' } },
        }, function PluginConfiguration(props) {
          return React.createElement('section', { 'data-fixture': 'plugin-configuration', style: { maxWidth: 760 } },
            React.createElement('h2', { style: { margin: '0 0 16px', fontSize: 18, fontWeight: 600 } }, '插件配置'),
            props.renderSlot(SLOT, { view: 'page' }, { entryKey: 'dsh-mnemon', fallback: React.createElement('p', null, 'dsh-mnemon has not registered its configuration.') }))
        })
      })
      ctx.slots.inject(SLOT, function () {
        var mirrored
        var dispose
        var sync = function () {
          var entry = ctx.slots.entriesOfSlot('plugins.bundle.config').find(function (candidate) { return candidate.options.key === 'dsh-mnemon' })
          if (entry === mirrored) return
          if (dispose !== undefined) { dispose(); dispose = undefined }
          mirrored = entry
          if (entry !== undefined) {
            dispose = ctx.slots.register({ name: SLOT, key: 'dsh-mnemon', locale: entry.locale, inject: entry.inject }, entry.component)
          }
        }
        sync()
        var off = ctx.slots.subscribe('plugins.bundle.config', sync)
        return function () { off(); if (dispose !== undefined) dispose() }
      })
    }
    module.exports = { apply: apply, inject: ['slots'] }
    return module.exports
  },
})
