import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { newVersionWaiting } from '../lib/appUpdate';
import { ErrorScreen } from './ErrorScreen';
import { UpdateBanner } from './UpdateBanner';

describe('UpdateBanner', () => {
  it('appears once a new version is waiting, and Reload switches to it', async () => {
    const { container } = render(<UpdateBanner />);
    expect(container).toBeEmptyDOMElement();

    const update = vi.fn(async () => {});
    act(() => newVersionWaiting(update));
    expect(screen.getByText('A new version of Wattle is available.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Reload/ }));
    expect(update).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: /Reload/ })).toBeDisabled();
  });
});

describe('ErrorScreen', () => {
  it('offers a reload instead of a blank page when rendering fails', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const Broken = () => {
      throw new Error('Failed to fetch dynamically imported module');
    };
    render(
      <ErrorScreen>
        <Broken />
      </ErrorScreen>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong loading Wattle.');
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to fetch dynamically imported module');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });
});
