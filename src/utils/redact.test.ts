import { describe, expect, it } from 'vitest';
import { redactSecrets, redactSecretsWithMetadata } from './redact.js';

describe('redactSecrets', () => {
  const sendGridKey = `SG.${'A'.repeat(22)}.${'B'.repeat(43)}`;

  it.each([
    [
      'Error: invalid key sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456',
      'Error: invalid key sk-ant-***REDACTED***',
    ],
    ['Auth failed with sk-proj-abcdefghijklmnopqrstuvwxyz', 'Auth failed with sk-***REDACTED***'],
    [
      'Header: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature',
      'Header: Bearer ***REDACTED***',
    ],
    ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz', 'Authorization: Bearer ***REDACTED***'],
    ['Error with gsk_abcdefghijklmnopqrstuvwxyz123456', 'Error with gsk_***REDACTED***'],
    ['Failed: xai-abcdefghijklmnopqrstuvwxyz123456', 'Failed: xai-***REDACTED***'],
    ['Hugging Face: hf_abcdefghijklmnopqrstuvwxyz123456', 'Hugging Face: hf_***REDACTED***'],
    [
      'DigitalOcean: dop_v1_abcdefghijklmnopqrstuvwxyz123456',
      'DigitalOcean: dop_v1_***REDACTED***',
    ],
    [
      'DigitalOcean OAuth: doo_v1_abcdefghijklmnopqrstuvwxyz123456',
      'DigitalOcean OAuth: doo_v1_***REDACTED***',
    ],
    [
      'DigitalOcean refresh: dor_v1_abcdefghijklmnopqrstuvwxyz123456',
      'DigitalOcean refresh: dor_v1_***REDACTED***',
    ],
    ['Stripe: sk_live_abcdefghijklmnopqrstuvwxyz', 'Stripe: sk_live_***REDACTED***'],
    [
      'Stripe restricted: rk_live_abcdefghijklmnopqrstuvwxyz',
      'Stripe restricted: rk_live_***REDACTED***',
    ],
    ['Stripe webhook: whsec_abcdefghijklmnopqrstuvwxyz', 'Stripe webhook: whsec_***REDACTED***'],
    ['token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij', 'token: ghp_***REDACTED***'],
    ['token: gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij', 'token: gho_***REDACTED***'],
    ['token: ghu_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij', 'token: ghu_***REDACTED***'],
    ['token: ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij', 'token: ghs_***REDACTED***'],
    [
      `token: ghs_1234567890_${'A'.repeat(120)}.${'B'.repeat(120)}.${'C'.repeat(120)}`,
      'token: ghs_***REDACTED***',
    ],
    [`token: ghr_${'A'.repeat(76)}`, 'token: ghr_***REDACTED***'],
    ['token: github_pat_ABCDEFGHIJKLMNOPQRSTUV22', 'token: github_pat_***REDACTED***'],
    [`token: glpat-${'A'.repeat(20)}`, 'token: glpat-***REDACTED***'],
    [`token: npm_${'A'.repeat(36)}`, 'token: npm_***REDACTED***'],
    ['aws_key: AKIAIOSFODNN7EXAMPLE', 'aws_key: AKIA***REDACTED***'],
    ['aws_session_key: ASIAIOSFODNN7EXAMPLE', 'aws_session_key: ASIA***REDACTED***'],
    [`sendgrid: ${sendGridKey}`, 'sendgrid: SG.***REDACTED***'],
    [`_xapp-1-${'A'.repeat(32)}_`, '_xapp-1-***REDACTED***_'],
    [`(pypi-${'A'.repeat(32)}).`, '(pypi-***REDACTED***).'],
    [`Google OAuth: GOCSPX-${'A'.repeat(28)}`, 'Google OAuth: GOCSPX-***REDACTED***'],
    [`Sentry: sntrys_${'A'.repeat(64)}`, 'Sentry: sntrys_***REDACTED***'],
    [
      `Sentry routable: sntrys_eyJpYXQiO${'A'.repeat(10)}InJlZ2lvbl91cmwi${'B'.repeat(10)}_${'C'.repeat(43)}`,
      'Sentry routable: sntrys_***REDACTED***',
    ],
    [`Databricks: dapi${'a'.repeat(32)}-1`, 'Databricks: dapi***REDACTED***'],
    [`Pulumi: pul-${'a'.repeat(40)}`, 'Pulumi: pul-***REDACTED***'],
    [`Linear: lin_api_${'A'.repeat(40)}`, 'Linear: lin_api_***REDACTED***'],
    [`Grafana: glsa_${'A'.repeat(32)}_${'b'.repeat(8)}`, 'Grafana: glsa_***REDACTED***'],
    [`GitLab runner: glrt-${'A'.repeat(20)}`, 'GitLab runner: glrt-***REDACTED***'],
    [`New Relic: NRAK-${'A'.repeat(27)}`, 'New Relic: NRAK-***REDACTED***'],
    [`Postman: PMAK-${'a'.repeat(24)}-${'B'.repeat(34)}`, 'Postman: PMAK-***REDACTED***'],
    ['-----BEGIN PGP PRIVATE KEY BLOCK-----', '***REDACTED***'],
    ['slack: xoxb-abcdefghijklmnop', 'slack: xoxb-***REDACTED***'],
    [
      'jwt: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
      'jwt: ***REDACTED***',
    ],
  ])('redacts known secret shapes', (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it('handles multiple keys in one string', () => {
    const msg = 'key1=sk-ant-api03-aaaabbbbccccddddeeeefffff key2=sk-proj-xxxxyyyyzzzzaaaabbbbcccc';
    const result = redactSecrets(msg);
    expect(result).not.toContain('aaaabbbbccccddddeeeefffff');
    expect(result).not.toContain('xxxxyyyyzzzzaaaabbbbcccc');
    expect(result).toContain('sk-ant-***REDACTED***');
    expect(result).toContain('sk-***REDACTED***');
  });

  it.each([
    '',
    'commit abc123def456789012345678901234567890abcd',
    'Error: key sk-short is invalid',
    `Stripe publishable key pk_live_${'A'.repeat(32)}`,
    'Hugging Face model hf_transformer',
    'DigitalOcean prefix dop_v1_short',
    'GitHub prefixes ghu_short ghs_short ghr_short',
    'identifierghu_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij',
    'GitLab prefix glpat-short',
    'npm package npm_example',
    'ASIA is a continent',
    'SendGrid label SG.example.invalid',
    'xapp-1-short pypi-project-name',
    `xapp-1-${'A'.repeat(257)}`,
    `pypi-${'A'.repeat(257)}`,
    'GOCSPX-short',
    'sntrys_placeholder',
    `dapi${'a'.repeat(31)}`,
    `pul-${'a'.repeat(39)}`,
    `lin_api_${'A'.repeat(39)}`,
    `glsa_${'A'.repeat(31)}_${'b'.repeat(8)}`,
    `glrt-${'A'.repeat(19)}`,
    `NRAK-${'A'.repeat(26)}`,
    `PMAK-${'a'.repeat(23)}-${'B'.repeat(34)}`,
    `GOCSPX-${'A'.repeat(29)}`,
    `sntrys_${'A'.repeat(513)}`,
    `dapi${'a'.repeat(33)}`,
    `pul-${'a'.repeat(41)}`,
    `lin_api_${'A'.repeat(41)}`,
    `glsa_${'A'.repeat(33)}_${'b'.repeat(8)}`,
    `glrt-${'A'.repeat(21)}`,
    `NRAK-${'A'.repeat(28)}`,
    `PMAK-${'a'.repeat(25)}-${'B'.repeat(34)}`,
    '{"secretariat":"public","tokenizer":"words","credentialsHelper":"safe"}',
    '-----BEGIN PGP PUBLIC KEY BLOCK-----',
    '-----BEGIN PUBLIC KEY-----',
    '-----BEGIN RSA PUBLIC KEY-----',
    '-----BEGIN CERTIFICATE-----',
  ])('leaves non-secret text unchanged', (message) => {
    expect(redactSecrets(message)).toBe(message);
  });

  it('returns redaction metadata and supports a custom marker', () => {
    const result = redactSecretsWithMetadata('password="hunter2"', { marker: '[REDACTED]' });

    expect(result).toEqual({ text: 'password="[REDACTED]"', redacted: true });
  });

  it('does not redact an authorization assignment twice', () => {
    const redacted = 'Authorization: Bearer ***REDACTED***';

    expect(redactSecretsWithMetadata(redacted)).toEqual({ text: redacted, redacted: false });
  });

  it('redacts quoted credential fields and password punctuation', () => {
    const result = redactSecrets(
      `{"api_key":"ordinary/@value!#[]{}","password":"p@$$w0rd!,;}]","clientSecret":'slash/+equals=question?'}`,
    );

    expect(result).toBe(
      `{"api_key":"***REDACTED***","password":"***REDACTED***","clientSecret":'***REDACTED***'}`,
    );
    expect(redactSecrets('password=p@$$w0rd!,;}]')).toBe('password=***REDACTED***');
  });

  it('redacts prefixed tokens beside underscores without matching embedded identifiers', () => {
    const token = `ghp_${'A'.repeat(24)}`;

    expect(redactSecrets(`_${token}_`)).toBe('_ghp_***REDACTED***_');
    expect(redactSecrets(`identifier${token}`)).toBe(`identifier${token}`);
  });

  it('leaves encoded payload inspection to the persisted-data scanner', () => {
    const encoded = Buffer.from(`sk-${'A'.repeat(24)}`, 'utf8').toString('base64');

    expect(redactSecrets(`payload=${encoded}`)).toBe(`payload=${encoded}`);
  });

  it('reports metadata for bare JWT-like tokens through the shared policy', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const result = redactSecretsWithMetadata(`token=${jwt}`, { marker: '[SECRET]' });

    expect(result).toEqual({ text: 'token=[SECRET]', redacted: true });
  });

  it('redacts URL credentials and private keys through the shared policy', () => {
    const result = redactSecretsWithMetadata(
      [
        'postgres://user:password@example.com/app',
        '-----BEGIN OPENSSH PRIVATE KEY-----',
        'secret-key-body',
        '-----END OPENSSH PRIVATE KEY-----',
      ].join('\n'),
    );

    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain('user:password@example.com');
    expect(result.text).not.toContain('secret-key-body');
  });

  it('redacts armored PGP private key blocks without retaining their body', () => {
    const result = redactSecrets(
      [
        '-----BEGIN PGP PRIVATE KEY BLOCK-----',
        'Version: synthetic',
        'private-key-body',
        '-----END PGP PRIVATE KEY BLOCK-----',
      ].join('\n'),
    );

    expect(result).toBe('-----BEGIN PRIVATE KEY-----\n***REDACTED***\n-----END PRIVATE KEY-----');
  });

  it.each([
    'PGP PRIVATE KEY BLOCK',
    'RSA PRIVATE KEY',
    'EC PRIVATE KEY',
    'OPENSSH PRIVATE KEY',
    'DSA PRIVATE KEY',
    'PRIVATE KEY',
    'ENCRYPTED PRIVATE KEY',
  ])('redacts the complete remainder of an unterminated %s block', (label) => {
    const result = redactSecrets(
      ['before', `-----BEGIN ${label}-----`, 'Version: synthetic', 'private-key-body'].join('\n'),
    );

    expect(result).toBe('before\n***REDACTED***');
    expect(result).not.toContain('private-key-body');
  });

  it('preserves text after a complete private key block', () => {
    const result = redactSecrets(
      [
        '-----BEGIN RSA PRIVATE KEY-----',
        'private-key-body',
        '-----END RSA PRIVATE KEY-----',
        'following diagnostic',
      ].join('\n'),
    );

    expect(result).toBe(
      [
        '-----BEGIN PRIVATE KEY-----',
        '***REDACTED***',
        '-----END PRIVATE KEY-----',
        'following diagnostic',
      ].join('\n'),
    );
  });
});
