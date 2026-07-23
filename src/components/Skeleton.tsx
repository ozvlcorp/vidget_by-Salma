export function Skeleton({ className = '' }: { className?: string }) {
  return <span className={`inline-block bg-surface-3 rounded animate-pulse ${className}`} />
}
