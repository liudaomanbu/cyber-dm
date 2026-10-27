import type {Script} from '../core/script.js';

/** Legacy built-ins remain stored for existing sessions, but are not selectable. */
export function selectableScripts(scripts:Record<string,Script>):Script[]{
 return Object.values(scripts).filter(script=>script.id!=='after-hours')
  .map(script=>script.id==='after-hours-live'?{...script,title:'闭馆之后'}:script);
}
