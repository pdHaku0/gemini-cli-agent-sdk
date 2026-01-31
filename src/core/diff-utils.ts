import { createTwoFilesPatch } from 'diff';

export function createUnifiedDiff(oldText: string, newText: string, path?: string, contextLines = 3): string {
    const fileLabel = path || 'file';
    const patch = createTwoFilesPatch(fileLabel, fileLabel, oldText || '', newText || '', '', '', { context: contextLines });
    return patch.trimEnd();
}
