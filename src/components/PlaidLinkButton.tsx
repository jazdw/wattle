import { usePlaidLink, type LinkKind } from '../hooks/usePlaidLink';
import { Button } from './ui/button';

interface Props {
  kind: LinkKind;
  /** Update mode: re-authenticate this connection. */
  connectionId?: string;
  /** With connectionId: choose which of its accounts to share. */
  chooseAccounts?: boolean;
  icon?: React.ReactNode;
  label: string;
  variant?: 'default' | 'outline' | 'accent';
  size?: 'default' | 'sm';
  onError?: (message: string) => void;
}

export function PlaidLinkButton({ kind, connectionId, chooseAccounts, icon, label, variant = 'default', size = 'default', onError }: Props) {
  const link = usePlaidLink({ connectionId, chooseAccounts, onError });
  return (
    <Button variant={variant} size={size} onClick={() => link.start(kind)} disabled={link.busy}>
      {icon}
      {link.importing ? 'Importing…' : label}
    </Button>
  );
}
