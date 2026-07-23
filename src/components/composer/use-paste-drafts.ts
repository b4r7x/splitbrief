import { useRef, useState, type Dispatch, type SetStateAction } from 'react';
import {
  extractPasteCapture,
  insertPasteDraftMarker,
  pasteDraftMarker,
  type PasteMarker,
} from './attachments.js';

export function usePasteDrafts(opts: { value: string; onChange: (next: string) => void }): {
  pastes: PasteMarker[];
  setPastes: Dispatch<SetStateAction<PasteMarker[]>>;
  handleChange: (next: string) => void;
  clearPastes: () => void;
} {
  const { value, onChange } = opts;
  const [pastes, setPastes] = useState<PasteMarker[]>([]);
  const pasteIdRef = useRef(0);

  const handleChange = (next: string) => {
    const capture = extractPasteCapture(value, next);
    if (capture) {
      const id = `paste-${pasteIdRef.current++}`;
      const marker = pasteDraftMarker();
      setPastes((prev) => [
        ...prev,
        { id, lineCount: capture.lineCount, marker, text: capture.text },
      ]);
      const inlineMarker = capture.insertAt > 0 || capture.remaining.length > capture.insertAt;
      onChange(
        inlineMarker
          ? insertPasteDraftMarker(capture.remaining, capture.insertAt, marker)
          : capture.remaining,
      );
      return;
    }
    onChange(next);
  };

  const clearPastes = () => {
    setPastes([]);
  };

  return { pastes, setPastes, handleChange, clearPastes };
}
