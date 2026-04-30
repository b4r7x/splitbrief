export function validateEmail(email: string): boolean {
  const trimmedEmail = email.trim();

  if (trimmedEmail.length === 0 || trimmedEmail !== email) {
    return false;
  }

  const atIndex = trimmedEmail.indexOf('@');
  if (atIndex <= 0 || atIndex !== trimmedEmail.lastIndexOf('@')) {
    return false;
  }

  const localPart = trimmedEmail.slice(0, atIndex);
  const domain = trimmedEmail.slice(atIndex + 1);

  if (localPart.length === 0 || domain.length === 0) {
    return false;
  }

  if (!/^[A-Za-z0-9._%+-]+$/.test(localPart)) {
    return false;
  }

  if (!/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(domain)) {
    return false;
  }

  return !domain.startsWith('.') && !domain.endsWith('.') && !domain.includes('..');
}
