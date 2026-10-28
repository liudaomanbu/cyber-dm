import type {Script} from '../core/script.js';

/** The retired built-in is also excluded from callers with pre-migration data. */
export function selectableScripts(scripts:Record<string,Script>):Script[]{
 return Object.values(scripts).filter(script=>script.id!=='after-hours')
  .map(script=>script.id==='after-hours-live'?{...script,title:'闭馆之后'}:script);
}
