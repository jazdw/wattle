import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { portfolio } from '../test/fixtures';
import { renderPage } from '../test/render';
import { server } from '../test/server';
import { Style } from './Style';

describe('Style page', () => {
  it('shows the size × style grid as shares of classified stocks', async () => {
    renderPage(<Style />);
    // large growth: 55,000 of 194,000 classified
    expect(await screen.findByTitle(/Large Growth: \$55,000/)).toHaveTextContent('28%');
    expect(screen.getByTitle(/Small Value/)).toHaveTextContent('3%');
    expect(screen.getByText(/have no size\/style/)).toBeInTheDocument();
  });

  it('splits stocks by region', async () => {
    renderPage(<Style />);
    const region = (await screen.findByText('Stocks by market')).closest('div.rounded-lg') as HTMLElement;
    expect(within(region).getByText('Australian stocks')).toBeInTheDocument();
    expect(within(region).getByText('46.9%')).toBeInTheDocument(); // US 150k of 320k
  });

  it('lists each fund’s stock value with its size and style, and opens the editor', async () => {
    const { user } = renderPage(<Style />);
    const vtiax = (await screen.findByText('VTIAX')).closest('tr') as HTMLElement;
    expect(within(vtiax).getByText('$70,000')).toBeInTheDocument();
    expect(within(vtiax).getByText(/Large 75%/)).toBeInTheDocument();
    expect(within(vtiax).getByText(/Value 38%/)).toBeInTheDocument();
    // Non-stock holdings are left out.
    expect(screen.queryByText('Insperity 401k Stable Value Trust')).not.toBeInTheDocument();

    await user.click(vtiax);
    expect(await screen.findByRole('dialog', { name: /Classify VTIAX/ })).toBeInTheDocument();
  });

  it('shows an empty state without stocks', async () => {
    const base = portfolio();
    const empty = { ...base, holdings: [], style: { ...base.style, unclassified: 0, equityTotal: 0 } };
    server.use(http.get('*/api/portfolio', () => HttpResponse.json(empty)));
    renderPage(<Style />);
    expect(await screen.findByText('No stock holdings yet')).toBeInTheDocument();
  });
});
