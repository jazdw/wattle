import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useNewVersion } from '../lib/appUpdate';
import { Button } from './ui/button';

/** Offers the new version once it's ready: open tabs keep the one they loaded until asked. */
export function UpdateBanner() {
  const update = useNewVersion();
  const [reloading, setReloading] = useState(false);
  if (!update) return null;
  return (
    <div role="status" className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-md items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3 text-sm shadow-lg">
      <span>A new version of Wattle is available.</span>
      <Button
        size="sm"
        disabled={reloading}
        onClick={() => {
          setReloading(true);
          void update();
        }}
      >
        <RefreshCw className={reloading ? 'animate-spin' : undefined} />
        Reload
      </Button>
    </div>
  );
}
