import { discoverSkills } from '../engine/skill-discovery.js';
import { configStore } from '../stores/project/config.js';
import { skillsStore } from '../stores/project/skills.js';
import { feedbackStore } from '../stores/ui/feedback.js';
import { toErrorMessage } from '../utils/format-errors.js';

export async function refreshSkills(): Promise<void> {
  const { projectDir } = configStore.get();
  if (!projectDir) return;
  try {
    skillsStore.setAvailable(await discoverSkills(projectDir));
  } catch (err: unknown) {
    feedbackStore.setError(`Could not rescan skills: ${toErrorMessage(err)}`);
  }
}
