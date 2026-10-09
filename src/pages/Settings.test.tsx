import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderPage } from '../test/render';
import { sent } from '../test/server';
import { Settings } from './Settings';

describe('Settings page', () => {
  it('shows members and privacy notes', async () => {
    renderPage(<Settings />);
    expect(await screen.findByText('sam@example.com')).toBeInTheDocument();
    expect(screen.getByText('Plaid environment: sandbox.')).toBeInTheDocument();
    expect(screen.getByText(/never full account or routing numbers/)).toBeInTheDocument();
  });

  it('saves the household name and default currency', async () => {
    const { user } = renderPage(<Settings />);
    const name = await screen.findByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'The Wiltshires');
    await user.selectOptions(screen.getByLabelText(/Default display currency/), 'AUD');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await expect.poll(() => sent('PATCH /api/household')[0]?.body).toEqual({ name: 'The Wiltshires', displayCurrency: 'AUD' });
    expect(await screen.findByRole('button', { name: 'Saved' })).toBeInTheDocument();
  });
});
