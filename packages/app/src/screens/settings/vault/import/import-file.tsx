interface PasswordsImportProps {
  serverId: string;
  operator: boolean;
  onClose: () => void;
}

/** Reading a chosen file needs the browser's file input, so only the web build renders this. */
export function PasswordsImport(_props: PasswordsImportProps): null {
  return null;
}

export const PASSWORDS_IMPORT_SUPPORTED = false;
