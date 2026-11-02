// Stand-in for a freshly restarted shared runtime service: one bounded sweep, then exit.
import {reclaimOrphanedAcp} from '../../cli/lib/orphan-recovery.mjs';

const home = process.argv[2];
const report = await reclaimOrphanedAcp({home, graceMs: 150, forceMs: 3000});
process.stdout.write(`${JSON.stringify(report)}\n`);
