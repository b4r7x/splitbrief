import { writeFile } from 'node:fs/promises';
import { buildThirdPartyNotices, THIRD_PARTY_NOTICES_PATH } from './third-party-notices.js';

await writeFile(THIRD_PARTY_NOTICES_PATH, await buildThirdPartyNotices(), 'utf8');
process.stdout.write('Third-party notices: public/THIRD_PARTY_NOTICES.txt generated\n');
