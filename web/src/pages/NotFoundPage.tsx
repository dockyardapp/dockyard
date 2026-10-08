import { Link, useLocation } from 'react-router-dom';
import { Button, EmptyState, PageHead } from '../components/ui';

export function NotFoundPage() {
  const location = useLocation();
  return (
    <>
      {/* Every other route renders a page heading. Without one this screen had
          no h1 for a screen reader to land on. */}
      <PageHead title="Page not found" desc="Nothing is routed at this address." />
      <EmptyState
        icon="search"
        title="No page here"
        action={
          <Link to="/">
            <Button variant="primary">Back to dashboard</Button>
          </Link>
        }
      >
        Nothing is routed at <code>{location.pathname}</code>.
      </EmptyState>
    </>
  );
}
