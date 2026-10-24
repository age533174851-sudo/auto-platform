/** Fail closed when the main worker lease cannot be proven. */
export async function mainLockGranted(acquire: () => Promise<boolean>): Promise<boolean> {
  try {
    return (await acquire()) === true;
  } catch {
    return false;
  }
}
