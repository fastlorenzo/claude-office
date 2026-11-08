/** localStorage flags behind the first-run controls card (best effort). */
const FIRST_KEY = "claude-office.world.controls";
const HELP_KEY = "claude-office.world.helpSeen";

function read(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function write(key: string): void {
  try {
    localStorage.setItem(key, "1");
  } catch {
    // storage unavailable: the card simply shows again next time
  }
}

export const controlsSeen = (): boolean => read(FIRST_KEY);
export const markControlsSeen = (): void => write(FIRST_KEY);
export const helpSeen = (): boolean => read(HELP_KEY);
export const markHelpSeen = (): void => write(HELP_KEY);
