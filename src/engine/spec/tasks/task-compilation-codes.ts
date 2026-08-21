import { TASK_COMPILATION_FAILURE_CODES } from '../../../core/schemas/task-compilation.js';
import { identityRecord } from '../../../utils/type-guards.js';

export const TASK_COMPILATION_FAILURE_CODE = identityRecord(TASK_COMPILATION_FAILURE_CODES);
