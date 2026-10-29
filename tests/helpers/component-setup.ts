// Per-file setup for the component project (05 §15.2): jest-dom matchers on Vitest's expect, and an
// unmounted DOM after every test (Testing Library cleans up by itself only with globals: true).
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(cleanup);
