// A sample MT5 trade history report for tests.
// Shaped like MT5's ReportHistory template: header rows, section rows with a
// single wide cell, header rows, repeated Time/Price columns, a hidden cell,
// numbers with space thousands separators.
const section = name => `<tr align="center"><th colspan="14" style="height:25px"><div style="font: 10pt Tahoma"><b>${name}</b></div></th></tr>`;
const row = (cells, attrs = 'bgcolor="#FFFFFF" align="right"') => `<tr ${attrs}>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`;
const REPORT = `<!DOCTYPE html><html><head><title>12345678: Trade History Report</title><style>td{font:8pt Tahoma}</style></head><body>
<div align="center"><table cellspacing="1" cellpadding="3" border="0">
<tr align="center"><td colspan="14"><div style="font: 20pt Tahoma"><b>Trade History Report</b></div></td></tr>
<tr align="left"><th colspan="4" nowrap align="right">Name:</th><th colspan="10" nowrap align="left"><b>Paul Maweu</b></th></tr>
<tr align="left"><th colspan="4" nowrap align="right">Account:</th><th colspan="10" nowrap align="left"><b>12345678 (USD, Exness-MT5Real8, real, Hedge)</b></th></tr>
<tr align="left"><th colspan="4" nowrap align="right">Company:</th><th colspan="10" nowrap align="left"><b>Exness Ltd</b></th></tr>
<tr align="left"><th colspan="4" nowrap align="right">Date:</th><th colspan="10" nowrap align="left"><b>2024.01.20 09:00</b></th></tr>
<tr><td style="height:10px"></td></tr>
${section('Positions')}
<tr align="center" bgcolor="#E5F0FC"><td nowrap><b>Time</b></td><td><b>Position</b></td><td><b>Symbol</b></td><td><b>Type</b></td><td class="hidden" colspan="8"></td><td><b>Volume</b></td><td><b>Price</b></td><td><b>S / L</b></td><td><b>T / P</b></td><td><b>Time</b></td><td><b>Price</b></td><td><b>Commission</b></td><td><b>Swap</b></td><td><b>Profit</b></td></tr>
<tr bgcolor="#FFFFFF" align="right"><td>2024.01.15 10:00:00</td><td>1001</td><td>XAUUSD</td><td>buy</td><td class="hidden" colspan="8"></td><td>0.10</td><td>2 020.50</td><td>2 010.00</td><td>2 040.00</td><td>2024.01.15 12:30:00</td><td>2 040.00</td><td>-0.70</td><td>0.00</td><td>195.00</td></tr>
<tr bgcolor="#F7F7F7" align="right"><td>2024.01.16 08:00:00</td><td>1002</td><td>EURUSD</td><td>sell</td><td class="hidden" colspan="8"></td><td>1.00</td><td>1.09500</td><td></td><td></td><td>2024.01.16 14:00:00</td><td>1.09200</td><td>-7.00</td><td>-1.50</td><td>300.00</td></tr>
<tr bgcolor="#FFFFFF" align="right"><td>2024.01.17 09:15:00</td><td>1003</td><td>GBPUSD</td><td>buy</td><td class="hidden" colspan="8"></td><td>0.50</td><td>1.27000</td><td>1.26800</td><td>1.27600</td><td>2024.01.17 11:00:00</td><td>1.26800</td><td>-3.50</td><td>0.00</td><td>- 100.00</td></tr>
<tr><td style="height:10px"></td></tr>
${section('Orders')}
${row(['<b>Open Time</b>', '<b>Order</b>', '<b>Symbol</b>', '<b>Type</b>', '<b>Volume</b>', '<b>Price</b>', '<b>S / L</b>', '<b>T / P</b>', '<b>Time</b>', '<b>State</b>', '<b>Comment</b>'], 'align="center"')}
${row(['2024.01.15 10:00:00', '1001', 'XAUUSD', 'buy', '0.10 / 0.10', 'market', '2 010.00', '2 040.00', '2024.01.15 10:00:00', 'filled', ''])}
<tr><td style="height:10px"></td></tr>
${section('Deals')}
${row(['<b>Time</b>', '<b>Deal</b>', '<b>Symbol</b>', '<b>Type</b>', '<b>Direction</b>', '<b>Volume</b>', '<b>Price</b>', '<b>Order</b>', '<b>Commission</b>', '<b>Fee</b>', '<b>Swap</b>', '<b>Profit</b>', '<b>Balance</b>', '<b>Comment</b>'], 'align="center"')}
${row(['2024.01.10 09:00:00', '5000', '', 'balance', '', '', '', '', '0.00', '0.00', '0.00', '10 000.00', '10 000.00', 'Deposit'])}
${row(['2024.01.15 10:00:00', '5001', 'XAUUSD', 'buy', 'in', '0.10', '2 020.50', '1001', '-0.35', '0.00', '0.00', '0.00', '9 999.65', ''])}
${row(['2024.01.15 12:30:00', '5002', 'XAUUSD', 'sell', 'out', '0.10', '2 040.00', '1011', '-0.35', '0.00', '0.00', '195.00', '10 194.30', '[tp 2040.00]'])}
${row(['2024.01.16 08:00:00', '5003', 'EURUSD', 'sell', 'in', '1.00', '1.09500', '1002', '-3.50', '0.00', '0.00', '0.00', '10 190.80', ''])}
${row(['2024.01.16 12:00:00', '5004', 'EURUSD', 'buy', 'out', '0.50', '1.09300', '1012', '-1.75', '0.00', '0.00', '100.00', '10 289.05', ''])}
${row(['2024.01.16 14:00:00', '5005', 'EURUSD', 'buy', 'out', '0.50', '1.09100', '1013', '-1.75', '0.00', '-1.50', '200.00', '10 485.80', ''])}
${row(['2024.01.17 09:15:00', '5006', 'GBPUSD', 'buy', 'in', '0.50', '1.27000', '1003', '-1.75', '0.00', '0.00', '0.00', '10 484.05', ''])}
${row(['2024.01.17 11:00:00', '5007', 'GBPUSD', 'sell', 'out', '0.50', '1.26800', '1014', '-1.75', '0.00', '0.00', '-100.00', '10 382.30', '[sl 1.26800]'])}
${row(['2024.01.18 10:00:00', '5008', '', 'balance', '', '', '', '', '0.00', '0.00', '0.00', '-500.00', '9 882.30', 'Withdrawal'])}
</table></div></body></html>`;

module.exports = { REPORT };
