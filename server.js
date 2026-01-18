#!/usr/bin/env node

require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 5176;

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;

if (!ALCHEMY_API_KEY || !ETHERSCAN_API_KEY) {
  console.error('❌ Error: Missing ALCHEMY_API_KEY or ETHERSCAN_API_KEY in .env file');
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(
  `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`
  );

const erc20Abi = [
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function balanceOf(address account) view returns (uint256)"
];

// Load contract database
let contractDatabase = {};
try {
  const dbPath = path.join(__dirname, 'contract_database.json');
  const dbContent = fs.readFileSync(dbPath, 'utf8');
  const db = JSON.parse(dbContent);
  
  // Create a lookup map by address (lowercase for case-insensitive matching)
  db.contracts.forEach(contract => {
    contractDatabase[contract.address.toLowerCase()] = contract;
  });
  
  console.log('✓ Contract database loaded successfully');
  console.log(`  Loaded ${Object.keys(contractDatabase).length} contracts`);
} catch (error) {
  console.warn('⚠ Contract database not found or invalid. Using fallback descriptions.');
  console.warn('  Place contract_database.json in the same directory as server.js');
}

app.use(express.json());

app.get('/', (req, res) => {
  res.send(getHtmlContent());
});

app.post('/api/approvals', async (req, res) => {
  try {
    const { walletAddress } = req.body;

    if (!walletAddress || !ethers.isAddress(walletAddress)) {
      return res.status(400).json({ error: 'Invalid Ethereum address' });
    }

    const approvalTopic = ethers.id("Approval(address,address,uint256)");
    const addressTopic = ethers.zeroPadValue(walletAddress, 32);

    const logs = await provider.getLogs({
      topics: [approvalTopic, addressTopic],
      fromBlock: 0,
      toBlock: 'latest'
    });

    const activeApprovals = new Map();

    for (const log of logs) {
      try {
        const iface = new ethers.Interface(erc20Abi);
        const parsedLog = iface.parseLog(log);
        const { spender } = parsedLog.args;
        const tokenAddress = log.address;
        const key = `${tokenAddress}-${spender}`;
        activeApprovals.set(key, { tokenAddress, spender });
      } catch (e) {
        // Skip non-matching logs
      }
    }

    const approvalPromises = Array.from(activeApprovals.values()).map(
      async (approval) => {
        try {
          const tokenContract = new ethers.Contract(
            approval.tokenAddress,
            erc20Abi,
            provider
          );

          const allowance = await tokenContract.allowance(
            walletAddress,
            approval.spender
          );

          if (allowance > 0n) {
            const [name, symbol, decimals, balance] = await Promise.all([
              tokenContract.name(),
              tokenContract.symbol(),
              tokenContract.decimals(),
              tokenContract.balanceOf(walletAddress)
            ]);

            const spenderDetails = await getSpenderDetails(approval.spender);

            return {
              tokenName: name,
              tokenSymbol: symbol,
              tokenAddress: approval.tokenAddress.toString(),
              spender: approval.spender.toString(),
              allowance: ethers.formatUnits(allowance, decimals).toString(),
              userBalance: ethers.formatUnits(balance, decimals).toString(),
              decimals: parseInt(decimals),
              spenderName: spenderDetails.name,
              spenderDescription: spenderDetails.description,
              isVerified: spenderDetails.isVerified,
              riskLevel: spenderDetails.riskLevel,
              category: spenderDetails.category,
              risks: spenderDetails.risks,
              benefits: spenderDetails.benefits,
              documentation: spenderDetails.documentation,
              audited: spenderDetails.audited
            };
          }
        } catch (e) {
          console.error(`Error processing approval:`, e.message);
          return null;
        }
      }
    );

    const detailedApprovals = (await Promise.all(approvalPromises)).filter(Boolean);

    res.json({
      success: true,
      count: detailedApprovals.length,
      approvals: detailedApprovals
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get contract details from database or Etherscan
 */
async function getSpenderDetails(spenderAddress) {
  try {
    // First, try to get from database
    const normalizedAddress = spenderAddress.toLowerCase();
    if (contractDatabase[normalizedAddress]) {
      const dbContract = contractDatabase[normalizedAddress];
      return {
        name: dbContract.name,
        description: dbContract.description,
        isVerified: dbContract.verified,
        riskLevel: dbContract.riskLevel,
        category: dbContract.category,
        risks: dbContract.risks,
        benefits: dbContract.benefits,
        documentation: dbContract.documentation,
        audited: dbContract.audited
      };
    }

    // If not in database, fall back to Etherscan
    const response = await axios.get('https://api.etherscan.io/api', {
      params: {
        module: 'contract',
        action: 'getsourcecode',
        address: spenderAddress,
        apikey: ETHERSCAN_API_KEY
      }
    });

    if (response.data.result && response.data.result[0]) {
      const contract = response.data.result[0];
      let name = contract.ContractName || 'Unknown Contract';
      
      return {
        name: name,
        description: getApprovalDescription(name),
        isVerified: contract.SourceCode ? true : false,
        riskLevel: 'unknown',
        category: 'Other',
        risks: ['Verify contract details before approving'],
        benefits: [],
        documentation: `https://etherscan.io/address/${spenderAddress}`,
        audited: false
      };
    }
  } catch (e) {
    console.error('Error fetching spender details:', e.message);
  }

  return {
    name: 'Unknown Contract',
    description: 'This contract can transfer your tokens.',
    isVerified: false,
    riskLevel: 'high',
    category: 'Unknown',
    risks: ['Could be a scam or malicious contract', 'No audit information available'],
    benefits: [],
    documentation: `https://etherscan.io/address/${spenderAddress}`,
    audited: false
  };
}

function getApprovalDescription(contractName) {
  const descriptions = {
    'UniswapV3Router': 'Can swap your tokens on Uniswap',
    'UniswapV2Router': 'Can swap your tokens on Uniswap',
    'SwapRouter': 'Can swap your tokens',
    'Seaport': 'Can transfer your NFTs and tokens for trading',
    'CurveStableSwap': 'Can use your tokens for swaps on Curve',
    'LidoStETH': 'Can stake your ETH for stETH',
    'WETH9': 'Can wrap/unwrap your ETH',
    'MasterChef': 'Can use your tokens in liquidity pools',
    'AavePool': 'Can use your tokens as collateral',
    'CompoundComptroller': 'Can use your tokens as collateral',
    'MakerDAO': 'Can use your tokens as collateral'
  };

  for (const [key, desc] of Object.entries(descriptions)) {
    if (contractName.includes(key)) {
      return desc;
    }
  }

  return 'This contract can transfer your tokens.';
}

app.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║     ApprovalGuard.io - MVP v3.0.0      ║');
  console.log('║   Professional Token Approval Manager   ║');
  console.log('╚════════════════════════════════════════╝\n');
  console.log(`🚀 Server running at http://localhost:${PORT}\n`  );
});

function getHtmlContent() {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ApprovalGuard.io</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background: linear-gradient(135deg, #5055e8ff 0%, #4ba288ff 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }

        .container {
            background: white;
            border-radius: 12px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            max-width: 1000px;
            width: 100%;
            padding: 40px;
        }

        .header {
            text-align: center;
            margin-bottom: 40px;
        }

        .header h1 {
            font-size: 32px;
            color: #1a1a1a;
            margin-bottom: 8px;
        }

        .header p {
            color: #666;
            font-size: 15px;
        }

        .wallet-section {
            display: flex;
            gap: 10px;
            margin-bottom: 30px;
            align-items: center;
        }

        .wallet-info {
            flex: 1;
            padding: 12px 16px;
            background: #f5f5f5;
            border: 2px solid #e0e0e0;
            border-radius: 8px;
            font-size: 14px;
            color: #666;
            word-break: break-all;
        }

        .wallet-info.connected {
            background: #e8f5e9;
            border-color: #4caf50;
            color: #2e7d32;
        }

        button {
            padding: 12px 24px;
            background: linear-gradient(135deg, #5055e8ff 0%, #4ba288ff 100%);
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 15px;
            font-weight: 600;
            cursor: pointer;
            transition: transform 0.2s, box-shadow 0.2s;
            white-space: nowrap;
        }

        button:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 20px rgba(102, 126, 234, 0.3);
        }

        button:disabled {
            opacity: 0.6;
            cursor: not-allowed;
            transform: none;
        }

        .input-section {
            display: flex;
            gap: 10px;
            margin-bottom: 30px;
        }

        input {
            flex: 1;
            padding: 12px 16px;
            border: 2px solid #e0e0e0;
            border-radius: 8px;
            font-size: 15px;
            transition: border-color 0.3s;
        }

        input:focus {
            outline: none;
            border-color: #667eea;
        }

        .message {
            display: none;
            padding: 12px 16px;
            border-radius: 8px;
            margin-bottom: 20px;
            font-size: 14px;
            font-weight: 500;
        }

        .message.success {
            background: #d4edda;
            color: #155724;
            border: 1px solid #c3e6cb;
        }

        .message.error {
            background: #f8d7da;
            color: #721c24;
            border: 1px solid #f5c6cb;
        }

        .loader {
            display: none;
            text-align: center;
            margin: 30px 0;
        }

        .spinner {
            border: 4px solid #f3f3f3;
            border-top: 4px solid #667eea;
            border-radius: 50%;
            width: 40px;
            height: 40px;
            animation: spin 1s linear infinite;
            margin: 0 auto;
        }

        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        .results {
            display: none;
        }

        .results h2 {
            font-size: 18px;
            color: #1a1a1a;
            margin-bottom: 20px;
        }

        .approval-card {
            background: #f9f9f9;
            border: 1px solid #e0e0e0;
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 15px;
        }

        .card-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
        }

        .card-header h3 {
            font-size: 16px;
            color: #1a1a1a;
        }

        .badge {
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: 600;
            color: white;
        }

        .badge.verified {
            background: #4caf50;
        }

        .badge.unverified {
            background: #ff9800;
        }

        .badge.low-risk {
            background: #4caf50;
        }

        .badge.medium-risk {
            background: #ff9800;
        }

        .badge.high-risk {
            background: #d32f2f;
        }

        .approval-description {
            background: white;
            padding: 12px;
            border-radius: 6px;
            margin-bottom: 12px;
            font-size: 14px;
            color: #333;
            border-left: 4px solid #667eea;
        }

        .card-details {
            background: white;
            padding: 12px;
            border-radius: 6px;
            margin-bottom: 12px;
            font-size: 13px;
        }

        .detail-row {
            display: flex;
            justify-content: space-between;
            padding: 8px 0;
            border-bottom: 1px solid #f0f0f0;
        }

        .detail-row:last-child {
            border-bottom: none;
        }

        .detail-label {
            color: #666;
            font-weight: 500;
        }

        .detail-value {
            color: #1a1a1a;
            word-break: break-all;
            text-align: right;
            flex: 1;
            margin-left: 10px;
        }

        .risks-benefits {
            background: white;
            padding: 12px;
            border-radius: 6px;
            margin-bottom: 12px;
            font-size: 13px;
        }

        .risks-list, .benefits-list {
            margin-bottom: 10px;
        }

        .risks-list:last-child {
            margin-bottom: 0;
        }

        .risks-list h4, .benefits-list h4 {
            color: #333;
            font-weight: 600;
            margin-bottom: 6px;
            font-size: 12px;
        }

        .risks-list ul, .benefits-list ul {
            list-style: none;
            padding-left: 0;
        }

        .risks-list li, .benefits-list li {
            color: #666;
            padding: 4px 0;
            padding-left: 16px;
            position: relative;
            font-size: 12px;
        }

        .risks-list li:before {
            content: "⚠ ";
            position: absolute;
            left: 0;
            color: #ff9800;
        }

        .benefits-list li:before {
            content: "✓ ";
            position: absolute;
            left: 0;
            color: #4caf50;
        }

        .revoke-btn {
            width: 100%;
            background: linear-gradient(135deg, #d32f2f 0%, #ff6f00 100%);
            padding: 12px;
            margin-top: 12px;
        }

        .revoke-btn:hover {
            background: #c82333;
        }

        .revoke-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            background: linear-gradient(135deg, #999999 0%, #666666 100%);
        }

        .revoke-btn:disabled:hover {
            background: linear-gradient(135deg, #999999 0%, #666666 100%);
            transform: none;
            box-shadow: none;
        }

        .revoke-btn:disabled {
            cursor: default;
        }

        .custom-tooltip {
            position: absolute;
            background-color: #FFD700;
            color: #000000;
            padding: 12px 16px;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 500;
            white-space: nowrap;
            z-index: 1000;
            pointer-events: none;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
            opacity: 0;
            transition: opacity 0.1s ease-in-out;
            bottom: 100%;
            left: 50%;
            transform: translateX(-50%);
            margin-bottom: 8px;
        }

        .custom-tooltip.show {
            opacity: 1;
        }

        .custom-tooltip::after {
            content: "";
            position: absolute;
            top: 100%;
            left: 50%;
            transform: translateX(-50%);
            border: 6px solid transparent;
            border-top-color: #FFD700;
        }

        .no-approvals {
            text-align: center;
            padding: 40px;
            color: #666;
        }

        .no-approvals-icon {
            font-size: 48px;
            margin-bottom: 10px;
        }

        .refresh-btn {
            background: linear-gradient(135deg, #5055e8ff 0%, #4ba288ff 100%);
            width: 100%;
            margin-top: 20px;
            padding: 12px 24px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🛡️ ApprovalGuard.io</h1>
            <p>Review and manage your token approvals</p>
        </div>

        <div class="wallet-section">
            <div id="walletInfo" class="wallet-info">Not connected</div>
            <button id="connectBtn">Connect Wallet to Sign In</button>
        </div>

        <div class="input-section">
            <input type="text" id="walletAddress" placeholder="Enter wallet address or use connected wallet" autocomplete="off" />
            <button id="fetchBtn">Find Approval</button>
        </div>

        <div id="message" class="message"></div>

        <div class="loader" id="loader">
            <div class="spinner"></div>
            <p style="margin-top: 10px; color: #666; font-size: 14px;">Finding approvals...</p>
        </div>

        <div id="results" class="results">
            <h2>Your Token Approvals</h2>
            <div id="approvalsContainer"></div>
        </div>

        <div id="noApprovals" class="no-approvals" style="display: none;">
            <div class="no-approvals-icon">✅</div>
            <p>No active approvals found</p>
        </div>

        <button id="refreshBtn" class="refresh-btn" style="display: none;">Refresh to Disconnect/Other Wallet</button>
    </div>

    <script>
        const walletInput = document.getElementById('walletAddress');
        const fetchBtn = document.getElementById('fetchBtn');
        const connectBtn = document.getElementById('connectBtn');
        const loader = document.getElementById('loader');
        const message = document.getElementById('message');
        const results = document.getElementById('results');
        const noApprovals = document.getElementById('noApprovals');
        const approvalsContainer = document.getElementById('approvalsContainer');
        const walletInfo = document.getElementById('walletInfo');
        const refreshBtn = document.getElementById('refreshBtn');

        let connectedAddress = null;

        connectBtn.addEventListener('click', async () => {
            try {
                const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
                connectedAddress = accounts[0];
                walletInput.value = connectedAddress;
                walletInfo.textContent = \`✓ Connected: \${connectedAddress.slice(0, 6)}...\${connectedAddress.slice(-4)}\`;
                walletInfo.classList.add('connected');
                connectBtn.textContent = 'Connected ✓';
                connectBtn.disabled = true;
                refreshBtn.style.display = 'block';
            } catch (error) {
                showMessage('Failed to connect wallet', 'error');
            }
        });

        refreshBtn.addEventListener('click', () => {
            location.reload();
        });

        fetchBtn.addEventListener('click', async () => {
            const address = walletInput.value.trim();

            if (!address) {
                showMessage('Please enter a wallet address or connect your wallet', 'error');
                return;
            }

            try {
                fetchBtn.disabled = true;
                loader.style.display = 'block';
                results.style.display = 'none';
                noApprovals.style.display = 'none';
                message.style.display = 'none';
                approvalsContainer.innerHTML = '';

                const response = await fetch('/api/approvals', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ walletAddress: address })
                });

                const data = await response.json();

                if (!response.ok) {
                    throw new Error(data.error || 'Failed to find approvals');
                }

                loader.style.display = 'none';

                if (data.count === 0) {
                    noApprovals.style.display = 'block';
                    showMessage('No active approvals found', 'success');
                } else {
                    results.style.display = 'block';
                    showMessage(\`Found \${data.count} active approval(s)\`, 'success');

                    data.approvals.forEach(approval => {
                        const isUnlimited = approval.allowance === '115792089237316195423570985008687907853269984665640564039457584007913129639935';
                        const allowanceDisplay = isUnlimited ? 'Unlimited' : approval.allowance;

                        const riskBadgeClass = approval.riskLevel === 'low' ? 'low-risk' : approval.riskLevel === 'medium' ? 'medium-risk' : 'high-risk';
                        const riskBadgeText = approval.riskLevel ? approval.riskLevel.charAt(0).toUpperCase() + approval.riskLevel.slice(1) + ' Risk' : 'Unknown Risk';

                        let risksHtml = '';
                        if (approval.risks && approval.risks.length > 0) {
                            risksHtml = \`
                                <div class="risks-list">
                                    <h4>Risks:</h4>
                                    <ul>
                                        \${approval.risks.map(risk => \`<li>\${risk}</li>\`).join('')}
                                    </ul>
                                </div>
                            \`;
                        }

                        let benefitsHtml = '';
                        if (approval.benefits && approval.benefits.length > 0) {
                            benefitsHtml = \`
                                <div class="benefits-list">
                                    <h4>Benefits:</h4>
                                    <ul>
                                        \${approval.benefits.map(benefit => \`<li>\${benefit}</li>\`).join('')}
                                    </ul>
                                </div>
                            \`;
                        }

                        const card = document.createElement('div');
                        card.className = 'approval-card';
                        card.innerHTML = \`
                            <div class="card-header">
                                <h3>\${approval.tokenName} (\${approval.tokenSymbol})</h3>
                                <div style="display: flex; gap: 8px;">
                                    <span class="badge \${approval.isVerified ? 'verified' : 'unverified'}">\${approval.isVerified ? '✓ Verified' : '⚠ Unverified'}</span>
                                    <span class="badge \${riskBadgeClass}">\${riskBadgeText}</span>
                                </div>
                            </div>

                            <div class="approval-description">
                                <strong>\${approval.spenderName}</strong> - \${approval.spenderDescription}
                            </div>

                            <div class="card-details">
                                <div class="detail-row">
                                    <span class="detail-label">Allowance</span>
                                    <span class="detail-value">\${allowanceDisplay}</span>
                                </div>
                                <div class="detail-row">
                                    <span class="detail-label">Your Balance</span>
                                    <span class="detail-value">\${parseFloat(approval.userBalance).toLocaleString()} \${approval.tokenSymbol}</span>
                                </div>
                                <div class="detail-row">
                                    <span class="detail-label">Category</span>
                                    <span class="detail-value">\${approval.category || 'Unknown'}</span>
                                </div>
                            </div>

                            \${risksHtml || benefitsHtml ? \`
                                <div class="risks-benefits">
                                    \${risksHtml}
                                    \${benefitsHtml}
                                </div>
                            \` : ''}

                            <div style="position: relative; display: inline-block; width: 100%;">
                                <button class="revoke-btn" 
                                    onclick="revokeApproval('\${approval.tokenAddress}', '\${approval.spender}', '\${address}')" 
                                    \${connectedAddress && connectedAddress.toLowerCase() === address.toLowerCase() ? '' : 'disabled'}
                                    onmouseenter="showCustomTooltip(this)" 
                                    onmouseleave="hideCustomTooltip(this)"
                                >Revoke Approval</button>
                                <div class="custom-tooltip">Revoke other address than you connected is not possible for security reasons</div>
                            </div>
                        \`;
                        approvalsContainer.appendChild(card);
                    });
                }
            } catch (error) {
                loader.style.display = 'none';
                showMessage(\`Error: \${error.message}\`, 'error');
            } finally {
                fetchBtn.disabled = false;
            }
        });

        async function revokeApproval(tokenAddress, spenderAddress, walletAddress) {
            if (!connectedAddress) {
                showMessage('Please connect your wallet first', 'error');
                return;
            }

            if (connectedAddress.toLowerCase() !== walletAddress.toLowerCase()) {
                showMessage('Connected wallet does not match the approval owner', 'error');
                return;
            }

            try {
                showMessage('Preparing revoke transaction...', 'success');

                const data = '0x095ea7b3' + 
                    spenderAddress.slice(2).padStart(64, '0') + 
                    '0'.padStart(64, '0');

                const tx = await window.ethereum.request({
                    method: 'eth_sendTransaction',
                    params: [{
                        from: connectedAddress,
                        to: tokenAddress,
                        data: data
                    }]
                });

                showMessage(\`Transaction sent: \${tx.slice(0, 10)}...\`, 'success');

                setTimeout(() => {
                    fetchBtn.click();
                }, 3000);

            } catch (error) {
                console.error('Revoke error:', error);
                showMessage(\`Error: \${error.message}\`, 'error');
            }
        }

        function showMessage(text, type) {
            message.textContent = text;
            message.className = \`message \${type}\`;
            message.style.display = 'block';
        }

        function showCustomTooltip(button) {
            if (button.disabled) {
                const tooltip = button.nextElementSibling;
                if (tooltip && tooltip.classList.contains('custom-tooltip')) {
                    tooltip.classList.add('show');
                }
            }
        }

        function hideCustomTooltip(button) {
            const tooltip = button.nextElementSibling;
            if (tooltip && tooltip.classList.contains('custom-tooltip')) {
                tooltip.classList.remove('show');
            }
        }

        walletInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') fetchBtn.click();
        });
    </script>
</body>
</html>
  `;
}
