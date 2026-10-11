export function ErrorNotice({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200"
    >
      {message}
    </div>
  );
}
