import { createContext, useContext } from 'react';

export interface LocalDirectorWorkspace {
  saving: boolean;
  save: () => Promise<void>;
  notify: (message: string) => void;
  previewExport: (blob: Blob, filename: string) => void;
}
const Context = createContext<LocalDirectorWorkspace | null>(null);
export const DirectorWorkspaceProvider = Context.Provider;
export const useDirectorWorkspace = () => useContext(Context);
