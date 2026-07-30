import { thirdPartyNoticeViolations } from './third-party-notices.js';

const violations = await thirdPartyNoticeViolations();
if (violations.length > 0) {
  throw new Error(`Third-party notice contract failed:\n${violations.join('\n')}`);
}

process.stdout.write('Third-party notices: verified\n');
