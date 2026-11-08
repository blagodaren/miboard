import { ru as common } from './common'
import { ru as monitoring } from './monitoring'
import { ru as routing } from './routing'
import { ru as geography } from './geography'
import { ru as analysis } from './analysis'
import { ru as backends } from './backends'
import { ru as latency } from './latency'

export default { ...common, ...monitoring, ...routing, ...geography, ...analysis, ...backends, ...latency }
