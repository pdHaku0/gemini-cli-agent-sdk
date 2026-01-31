import './globals.css';
import type { ReactNode } from 'react';

export const metadata = {
  title: 'Agent Chat Example',
  description: 'Next.js example for gemini-cli-agent-sdk',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
