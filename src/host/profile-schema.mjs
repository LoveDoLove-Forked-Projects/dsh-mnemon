import * as cosmokit from '@deepseek-ai/cosmokit'
import LegacySchema from 'schemastery'

// Desktop generations share the host's framework packages. Older hosts own
// Cosmokit 1.8.3, which cannot even link the live schema's named imports.
// Inspect the public capability before importing that optional runtime path.
const predicate = Reflect.get(cosmokit, 'isVolatile')
export const supportsLiveConfig = typeof predicate === 'function'
  && typeof Reflect.get(cosmokit, 'createVolatile') === 'function'
export const isVolatile = value => supportsLiveConfig && predicate(value)

// Keep the public ESM runtime while isolating its incompatible global types.
export default supportsLiveConfig ? (await import('schemastery-live')).default : LegacySchema
