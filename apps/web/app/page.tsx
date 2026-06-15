import { redirect } from 'next/navigation';

// Root redirect: unauthenticated users go to login
// Authenticated users would be redirected to dashboard (BFF handles session check)
export default function Home() {
  redirect('/login');
}
