import { assertNever } from '../../utils/type-guards.js';

export type CliVersionCompatibility = 'compatible' | 'incompatible' | 'unverified';

export type CliVersionScheme = 'semver' | 'calver';

type CanonicalSemver = Readonly<{
  major: number;
  minor: number;
  patch: number;
}>;

const CANONICAL_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseCanonicalSemver(version: string): CanonicalSemver | null {
  const match = CANONICAL_SEMVER.exec(version);
  if (match === null) return null;

  const [majorPart, minorPart, patchPart] = match.slice(1);
  if (majorPart === undefined || minorPart === undefined || patchPart === undefined) return null;

  const parsed = {
    major: Number(majorPart),
    minor: Number(minorPart),
    patch: Number(patchPart),
  };
  return Number.isSafeInteger(parsed.major) &&
    Number.isSafeInteger(parsed.minor) &&
    Number.isSafeInteger(parsed.patch)
    ? parsed
    : null;
}

function compareCanonicalSemver(
  input: Readonly<{ left: CanonicalSemver; right: CanonicalSemver }>,
): number {
  if (input.left.major !== input.right.major) {
    return input.left.major < input.right.major ? -1 : 1;
  }
  if (input.left.minor !== input.right.minor) {
    return input.left.minor < input.right.minor ? -1 : 1;
  }
  if (input.left.patch !== input.right.patch) {
    return input.left.patch < input.right.patch ? -1 : 1;
  }
  return 0;
}

type CanonicalCalver = Readonly<{
  year: number;
  month: number;
  day: number;
}>;

const CANONICAL_CALVER = /^(\d{4})\.(\d{2})\.(\d{2})(?:-[A-Za-z0-9]+)?$/;

function parseCanonicalCalver(version: string): CanonicalCalver | null {
  const match = CANONICAL_CALVER.exec(version);
  if (match === null) return null;

  const [yearPart, monthPart, dayPart] = match.slice(1);
  if (yearPart === undefined || monthPart === undefined || dayPart === undefined) return null;

  const parsed = {
    year: Number(yearPart),
    month: Number(monthPart),
    day: Number(dayPart),
  };
  return Number.isSafeInteger(parsed.year) &&
    Number.isSafeInteger(parsed.month) &&
    Number.isSafeInteger(parsed.day)
    ? parsed
    : null;
}

function compareCanonicalCalver(
  input: Readonly<{ left: CanonicalCalver; right: CanonicalCalver }>,
): number {
  if (input.left.year !== input.right.year) {
    return input.left.year < input.right.year ? -1 : 1;
  }
  if (input.left.month !== input.right.month) {
    return input.left.month < input.right.month ? -1 : 1;
  }
  if (input.left.day !== input.right.day) {
    return input.left.day < input.right.day ? -1 : 1;
  }
  return 0;
}

function compareCliVersions(
  input: Readonly<{
    installedVersion: string;
    baselineVersion: string;
    versionScheme: CliVersionScheme;
  }>,
): number | null {
  switch (input.versionScheme) {
    case 'semver': {
      const installed = parseCanonicalSemver(input.installedVersion);
      const baseline = parseCanonicalSemver(input.baselineVersion);
      if (installed === null || baseline === null) return null;
      return compareCanonicalSemver({ left: installed, right: baseline });
    }
    case 'calver': {
      const installed = parseCanonicalCalver(input.installedVersion);
      const baseline = parseCanonicalCalver(input.baselineVersion);
      if (installed === null || baseline === null) return null;
      return compareCanonicalCalver({ left: installed, right: baseline });
    }
    default:
      return assertNever(input.versionScheme);
  }
}

/**
 * The sole descriptor-owned version compatibility decision.
 * Forward-compatible: releases at or above the minimum admitted version are
 * compatible; only older releases fail closed as incompatible. An unparseable
 * version stays unverified.
 */
export function classifyCliAdmittedVersion(
  input: Readonly<{
    installedVersion: string;
    minimumAdmittedVersion: string;
    versionScheme?: CliVersionScheme;
  }>,
): CliVersionCompatibility {
  const order = compareCliVersions({
    installedVersion: input.installedVersion,
    baselineVersion: input.minimumAdmittedVersion,
    versionScheme: input.versionScheme ?? 'semver',
  });
  if (order === null) return 'unverified';
  return order < 0 ? 'incompatible' : 'compatible';
}

export type CliCompilerVersionClassification = 'exact' | 'older' | 'newer' | 'mismatch';

/**
 * The compiler path admits exactly the tested runtime version (REQ-049).
 * Older releases, newer releases, and unparseable claims are never ready —
 * unlike the forward-compatible `classifyCliAdmittedVersion` used by the
 * implementer path, this classifier has no compatibility arm to borrow.
 */
export function classifyCliCompilerVersion(
  input: Readonly<{
    installedVersion: string;
    exactAdmittedVersion: string;
    versionScheme?: CliVersionScheme;
  }>,
): CliCompilerVersionClassification {
  const order = compareCliVersions({
    installedVersion: input.installedVersion,
    baselineVersion: input.exactAdmittedVersion,
    versionScheme: input.versionScheme ?? 'semver',
  });
  if (order === null) return 'mismatch';
  if (order === 0) return 'exact';
  return order < 0 ? 'older' : 'newer';
}
