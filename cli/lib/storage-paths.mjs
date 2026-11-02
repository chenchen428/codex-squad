import {homedir} from 'node:os';
import {join,resolve} from 'node:path';

export function dataRoot(options={}){
  return resolve(options.home||options.env?.PLUGIN_DATA||process.env.PLUGIN_DATA||join(homedir(),'.codex-squad'));
}
