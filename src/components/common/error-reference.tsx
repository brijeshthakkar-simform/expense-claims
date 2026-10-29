import { cn } from '@/lib/utils';

/**
 * "Reference: <id>" on every error surface (05 §5.1). For API errors the id is the x-request-id
 * that support greps in the logs; for render errors it is Next's error digest.
 */
export function ErrorReference({ id, className }: { id?: string; className?: string }) {
  if (!id) return null;
  return (
    <p className={cn('text-muted-foreground text-xs', className)}>
      Reference: <code className="font-mono select-all">{id}</code>
    </p>
  );
}
