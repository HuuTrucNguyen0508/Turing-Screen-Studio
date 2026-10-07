import { useEffect, useState } from 'react';
import { parseStudioTheme } from './domain/studioTheme';
const preferenceKey = 'turzx-studio.appearance.v1';

export default function useStudioTheme() {
  const [preference, setPreference] = useState(() => {
    try { return parseStudioTheme(localStorage.getItem(preferenceKey)); }
    catch { return parseStudioTheme(null); }
  });
  const [storageError, setStorageError] = useState('');
  useEffect(() => {
    try { localStorage.setItem(preferenceKey, JSON.stringify(preference)); setStorageError(''); }
    catch { setStorageError('Studio colors work in this tab, but could not be remembered in this browser.'); }
  }, [preference]);
  return { preference, setPreference, storageError };
}
