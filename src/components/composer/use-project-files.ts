import { useEffect, useState } from 'react';
import { listProjectFiles } from '../../lib/file-listing.js';
import { SPLITBRIEF_DIR, SESSIONS_DIR } from '../../core/paths.js';
import { projectFilesStore } from '../../stores/ui/project-files.js';

const SESSIONS_REL_DIR = `${SPLITBRIEF_DIR}/${SESSIONS_DIR}`;
const SESSIONS_EXCLUDE = new RegExp(`(?:^|/)${SESSIONS_REL_DIR.replace(/[.]/g, '\\$&')}/`);

async function readProjectFiles(
  projectDir: string,
  listFiles: typeof listProjectFiles,
): Promise<string[]> {
  if (!projectDir) return [];
  try {
    return await listFiles(projectDir, {
      excludePatterns: [SESSIONS_EXCLUDE],
      skipRelativeDirs: [SESSIONS_REL_DIR],
    });
  } catch {
    return [];
  }
}

export function useProjectFiles(projectDir: string, listFiles = listProjectFiles): string[] {
  const refreshEpoch = projectFilesStore.use((s) => s.refreshEpoch);
  const [projectFiles, setProjectFiles] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    void readProjectFiles(projectDir, listFiles).then((files) => {
      if (active) setProjectFiles(files);
    });
    return () => {
      active = false;
    };
  }, [projectDir, refreshEpoch, listFiles]);

  return projectFiles;
}
