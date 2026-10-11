import { Link } from 'react-router';
import { EmptyState } from '../components/EmptyState';

export function NotFoundPage() {
  return (
    <EmptyState title="Page not found">
      <Link to="/" className="text-sky-400 hover:text-sky-300">
        Return to the overview
      </Link>
    </EmptyState>
  );
}
