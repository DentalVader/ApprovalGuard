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

// Load exploit database
let exploitDatabase = {};
try {
  const exploitPath = path.join(__dirname, 'exploit_database.json');
  const exploitContent = fs.readFileSync(exploitPath, 'utf8');
  const exploitDb = JSON.parse(exploitContent);
  
  // Create a lookup map by affected contracts (lowercase for case-insensitive matching)
  exploitDb.exploits.forEach(exploit => {
    exploit.affectedContracts.forEach(contract => {
      const key = contract.toLowerCase();
      if (!exploitDatabase[key]) {
        exploitDatabase[key] = [];
      }
      exploitDatabase[key].push(exploit);
    });
  });
  
  console.log('✓ Exploit database loaded successfully');
  console.log(`  Loaded ${exploitDb.exploits.length} exploits`);
} catch (error) {
  console.warn('⚠ Exploit database not found or invalid.');
  console.warn('  Place exploit_database.json in the same directory as server.js');
}

app.use(express.json());

app.get('/', (req, res) => {
  res.send(getHtmlContent());
});

app.get('/api/about', (req, res) => {
  try {
    const aboutPath = path.join(__dirname, 'ABOUT_APPROVALGUARD.md');
    const aboutContent = fs.readFileSync(aboutPath, 'utf8');
    res.type('text/plain').send(aboutContent);
  } catch (error) {
    res.status(500).send('Unable to load about content');
  }
});

app.get('/api/knowledge', (req, res) => {
  try {
    const knowledgePath = path.join(__dirname, 'knowledge_base.md');
    const knowledgeContent = fs.readFileSync(knowledgePath, 'utf8');
    
    // Simple markdown to HTML conversion
    let html = knowledgeContent
      .replace(/^# (.*?)$/gm, '<h2>$1</h2>')
      .replace(/^## (.*?)$/gm, '<h3>$1</h3>')
      .replace(/^### (.*?)$/gm, '<h4>$1</h4>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/^(?!<[h|u|p|t|s])/gm, '<p>')
      .replace(/(?<!<\/[h|u|p|t|s]>)$/gm, '</p>');
    
    res.type('text/html').send(html);
  } catch (error) {
    res.status(500).send('<p>Unable to load knowledge content</p>');
  }
});

app.post('/api/approvals', async (req, res) => {
  try {
    const { walletAddress, chainId } = req.body;

    if (!walletAddress || !ethers.isAddress(walletAddress)) {
      return res.status(400).json({ error: 'Invalid Ethereum address' });
    }

    // For now, only support Ethereum mainnet (chainId 1)
    // In future, this can be extended to support other networks
    if (chainId && chainId !== 1) {
      return res.status(400).json({ error: 'Currently only Ethereum mainnet is supported' });
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
            const exploits = checkForExploits(approval.spender);
            const riskScoring = calculateRiskScore(spenderDetails, allowance.toString(), balance.toString(), exploits);

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
              audited: spenderDetails.audited,
              riskScore: riskScoring.score,
              riskFactors: riskScoring.factors,
              exploits: exploits,
              hasKnownExploit: exploits.length > 0
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
 * Calculate risk score (0-100) for an approval
 */
function calculateRiskScore(spenderDetails, allowance, userBalance, exploits = []) {
  let riskScore = 0;
  const riskFactors = [];

  // Factor 1: Audit Status (0-25 points)
  if (spenderDetails.audited) {
    riskScore += 0;
    riskFactors.push({ name: 'Audit Status', value: 'Audited', contribution: 0 });
  } else if (spenderDetails.isVerified) {
    riskScore += 12;
    riskFactors.push({ name: 'Audit Status', value: 'Verified', contribution: 12 });
  } else {
    riskScore += 25;
    riskFactors.push({ name: 'Audit Status', value: 'Not Audited', contribution: 25 });
  }

  // Factor 2: Category Risk (0-20 points)
  const categoryRiskMap = {
    'DEX': 4,
    'Lending': 12,
    'Staking': 8,
    'Bridge': 15,
    'NFT': 20,
    'Other': 20,
    'Unknown': 25
  };
  const categoryRisk = categoryRiskMap[spenderDetails.category] || 20;
  riskScore += categoryRisk;
  riskFactors.push({ name: 'Category', value: spenderDetails.category, contribution: categoryRisk });

  // Factor 3: Risk Level (0-20 points)
  const riskLevelMap = {
    'low': 0,
    'medium': 10,
    'high': 20,
    'unknown': 15
  };
  const riskLevelScore = riskLevelMap[spenderDetails.riskLevel] || 15;
  riskScore += riskLevelScore;
  riskFactors.push({ name: 'Risk Level', value: spenderDetails.riskLevel, contribution: riskLevelScore });

  // Factor 4: Allowance Amount (0-20 points)
  const allowanceBigInt = BigInt(allowance);
  const maxUint256 = BigInt('115792089237316195423570985008687907853269984665640564039457584007913129639935');
  
  if (allowanceBigInt === maxUint256) {
    riskScore += 20;
    riskFactors.push({ name: 'Allowance', value: 'Unlimited', contribution: 20 });
  } else if (allowanceBigInt > BigInt(userBalance) * BigInt(10)) {
    riskScore += 15;
    riskFactors.push({ name: 'Allowance', value: 'Very High (>10x balance)', contribution: 15 });
  } else if (allowanceBigInt > BigInt(userBalance)) {
    riskScore += 10;
    riskFactors.push({ name: 'Allowance', value: 'High (>balance)', contribution: 10 });
  } else {
    riskScore += 5;
    riskFactors.push({ name: 'Allowance', value: 'Reasonable', contribution: 5 });
  }

  // Factor 5: Known Exploits (0-15 points)
  if (exploits && exploits.length > 0) {
    riskScore += 15;
    riskFactors.push({ name: 'Known Exploits', value: exploits.length + ' exploit(s) found', contribution: 15 });
  } else {
    riskFactors.push({ name: 'Known Exploits', value: 'None', contribution: 0 });
  }

  // Cap the score at 100
  riskScore = Math.min(riskScore, 100);

  return {
    score: riskScore,
    factors: riskFactors
  };
}

/**
 * Check if a spender address is associated with known exploits
 */
function checkForExploits(spenderAddress) {
  const normalizedAddress = spenderAddress.toLowerCase();
  return exploitDatabase[normalizedAddress] || [];
}

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

        .about-btn {
            padding: 2px 8px;
            background: #4caf50;
            color: white;
            border: none;
            border-radius: 4px;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            transition: background 0.2s;
            display: inline;
            margin: 0 2px;
            vertical-align: middle;
        }

        .about-btn:hover {
            background: #45a049;
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
            -webkit-transform: translateY(-2px);
            box-shadow: 0 10px 20px rgba(102, 126, 234, 0.3);
            -webkit-box-shadow: 0 10px 20px rgba(102, 126, 234, 0.3);
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
        
        .clear-icon {
            cursor: pointer;
            color: #999;
            font-size: 18px;
            font-weight: bold;
            user-select: none;
            transition: color 0.2s;
            display: none;
            padding: 0 8px;
            line-height: 1;
            align-self: center;
        }
        
        .clear-icon:hover {
            color: #333;
        }
        
        .clear-icon.show {
            display: block;
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
            0% { transform: rotate(0deg); -webkit-transform: rotate(0deg); }
            100% { transform: rotate(360deg); -webkit-transform: rotate(360deg); }
        }
        
        @-webkit-keyframes spin {
            0% { -webkit-transform: rotate(0deg); }
            100% { -webkit-transform: rotate(360deg); }
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
            -webkit-box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
            opacity: 0;
            transition: opacity 0.1s ease-in-out;
            -webkit-transition: opacity 0.1s ease-in-out;
            bottom: 100%;
            left: 50%;
            transform: translateX(-50%);
            -webkit-transform: translateX(-50%);
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
        
        /* Modal Styles */
        .modal {
            display: none;
            position: fixed;
            z-index: 1000;
            left: 0;
            top: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0, 0, 0, 0.5);
        }

        .modal-content {
            background-color: white;
            margin: 5% auto;
            padding: 30px;
            border-radius: 12px;
            width: 90%;
            max-width: 800px;
            max-height: 80vh;
            overflow-y: auto;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            white-space: pre-wrap;
            word-wrap: break-word;
            font-size: 14px;
            line-height: 1.6;
        }

        .modal-close {
            color: #aaa;
            float: right;
            font-size: 28px;
            font-weight: bold;
            cursor: pointer;
        }

        .modal-close:hover {
            color: #000;
        }
        
        .risk-factors-section {
            background: #f5f5f5;
            padding: 12px;
            border-radius: 6px;
            margin-bottom: 12px;
            border-left: 4px solid #FF9800;
        }
        
        .risk-factors-section h4 {
            margin: 0 0 10px 0;
            font-size: 14px;
            color: #333;
        }
        
        .risk-factors-list {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        
        .risk-factor-item {
            display: flex;
            justify-content: space-between;
            padding: 8px;
            background: white;
            border-radius: 4px;
            font-size: 13px;
        }
        
        .factor-name {
            font-weight: 600;
            color: #333;
            min-width: 120px;
        }
        
        .factor-value {
            color: #666;
            flex: 1;
            text-align: center;
        }
        
        .factor-contribution {
            font-weight: 600;
            color: #FF9800;
            min-width: 60px;
            text-align: right;
        }
        
        .exploit-warning {
            background: #FFF3CD;
            border: 1px solid #FFE69C;
            border-left: 4px solid #FF6B6B;
            padding: 12px;
            border-radius: 6px;
            margin-bottom: 12px;
            color: #856404;
            font-size: 13px;
        }
        
        .exploit-warning strong {
            color: #FF6B6B;
            display: block;
            margin-bottom: 8px;
        }
        
        .exploit-warning ul {
            margin: 0;
            padding-left: 20px;
        }
        
        .exploit-warning li {
            margin: 4px 0;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🛡️ ApprovalGuard.io</h1>
            <p>Review and manage your token approvals</p>
            <p style="margin-top: 8px; font-size: 14px;">Learn More <button id="aboutBtn" class="about-btn">About</button> Approvals | <button id="knowledgeBtn" class="about-btn">Knowledge</button></p>
        </div>

        <div class="wallet-section">
            <div id="walletInfo" class="wallet-info">Not connected</div>
            <button id="connectBtn">Connect Wallet to Sign In</button>
        </div>

        <div class="input-section">
            <input type="text" id="walletAddress" placeholder="Enter wallet address or use connected wallet" autocomplete="off" />
            <span class="clear-icon" id="clearIcon">&times;</span>
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
        const aboutBtn = document.getElementById('aboutBtn');
        const knowledgeBtn = document.getElementById('knowledgeBtn');
        const clearIcon = document.getElementById('clearIcon');

        let connectedAddress = null;
        
        // Clear icon functionality
        walletInput.addEventListener('input', () => {
            if (walletInput.value.trim()) {
                clearIcon.classList.add('show');
            } else {
                clearIcon.classList.remove('show');
            }
        });
        
        clearIcon.addEventListener('click', () => {
            walletInput.value = '';
            clearIcon.classList.remove('show');
            walletInput.focus();
        });

        knowledgeBtn.addEventListener('click', async () => {
            const modal = document.getElementById('knowledgeModal');
            const content = document.getElementById('knowledgeContent');
            
            try {
                const response = await fetch('/api/knowledge');
                const html = await response.text();
                content.innerHTML = html;
                modal.style.display = 'block';
            } catch (error) {
                content.innerHTML = '<p>Unable to load knowledge content</p>';
                modal.style.display = 'block';
            }
        });
        
        const modalCloseKnowledge = document.querySelector('.modal-close-knowledge');
        if (modalCloseKnowledge) {
            modalCloseKnowledge.addEventListener('click', () => {
                document.getElementById('knowledgeModal').style.display = 'none';
            });
        }
        
        window.addEventListener('click', (event) => {
            const knowledgeModal = document.getElementById('knowledgeModal');
            if (event.target === knowledgeModal) {
                knowledgeModal.style.display = 'none';
            }
        });

        aboutBtn.addEventListener('click', async () => {
            const modal = document.getElementById('aboutModal');
            const content = document.getElementById('aboutContent');
            
            try {
                const response = await fetch('/api/about');
                const text = await response.text();
                content.textContent = text;
                modal.style.display = 'block';
            } catch (error) {
                content.textContent = 'Unable to load content';
                modal.style.display = 'block';
            }
        });
        
        const modalClose = document.querySelector('.modal-close');
        if (modalClose) {
            modalClose.addEventListener('click', () => {
                document.getElementById('aboutModal').style.display = 'none';
            });
        }
        
        window.addEventListener('click', (event) => {
            const modal = document.getElementById('aboutModal');
            if (event.target === modal) {
                modal.style.display = 'none';
            }
        });

        function getNetworkInfo(chainId) {
            const networks = {"1": {"id": 1, "name": "Ethereum", "shortName": "eth", "rpc": "https://eth-mainnet.g.alchemy.com/v2/", "explorer": "https://etherscan.io", "currency": "ETH", "type": "mainnet"}, "137": {"id": 137, "name": "Polygon", "shortName": "matic", "rpc": "https://polygon-mainnet.g.alchemy.com/v2/", "explorer": "https://polygonscan.com", "currency": "MATIC", "type": "mainnet"}, "42161": {"id": 42161, "name": "Arbitrum One", "shortName": "arb1", "rpc": "https://arb-mainnet.g.alchemy.com/v2/", "explorer": "https://arbiscan.io", "currency": "ETH", "type": "mainnet"}, "10": {"id": 10, "name": "Optimism", "shortName": "opt", "rpc": "https://opt-mainnet.g.alchemy.com/v2/", "explorer": "https://optimistic.etherscan.io", "currency": "ETH", "type": "mainnet"}, "8453": {"id": 8453, "name": "Base", "shortName": "base", "rpc": "https://base-mainnet.g.alchemy.com/v2/", "explorer": "https://basescan.org", "currency": "ETH", "type": "mainnet"}, "56": {"id": 56, "name": "BNB Smart Chain", "shortName": "bsc", "rpc": "https://bsc-dataseed.bnbchain.org:443", "explorer": "https://bscscan.com", "currency": "BNB", "type": "mainnet"}, "250": {"id": 250, "name": "Fantom", "shortName": "ftm", "rpc": "https://rpc.ftm.tools", "explorer": "https://ftmscan.com", "currency": "FTM", "type": "mainnet"}, "43114": {"id": 43114, "name": "Avalanche C-Chain", "shortName": "avax", "rpc": "https://api.avax.network/ext/bc/C/rpc", "explorer": "https://snowtrace.io", "currency": "AVAX", "type": "mainnet"}, "25": {"id": 25, "name": "Cronos", "shortName": "cro", "rpc": "https://evm.cronos.org", "explorer": "https://cronoscan.com", "currency": "CRO", "type": "mainnet"}, "1101": {"id": 1101, "name": "Polygon zkEVM", "shortName": "zkEVM", "rpc": "https://zkevm-rpc.com", "explorer": "https://zkevm.polygonscan.com", "currency": "ETH", "type": "mainnet"}, "324": {"id": 324, "name": "zkSync Era", "shortName": "zksync", "rpc": "https://mainnet.era.zksync.io", "explorer": "https://explorer.zksync.io", "currency": "ETH", "type": "mainnet"}, "59144": {"id": 59144, "name": "Linea", "shortName": "linea", "rpc": "https://rpc.linea.build", "explorer": "https://lineascan.com", "currency": "ETH", "type": "mainnet"}, "34443": {"id": 34443, "name": "Mode", "shortName": "mode", "rpc": "https://mainnet.mode.network", "explorer": "https://modescan.io", "currency": "ETH", "type": "mainnet"}, "7": {"id": 7, "name": "ThunderCore Testnet", "shortName": "tt-test", "rpc": "https://testnet-rpc.thundercore.com", "explorer": "https://testnet-explorer.thundercore.com", "currency": "TT", "type": "testnet"}, "288": {"id": 288, "name": "Boba Network", "shortName": "boba", "rpc": "https://mainnet.boba.network", "explorer": "https://bobascan.com", "currency": "ETH", "type": "mainnet"}, "100": {"id": 100, "name": "Gnosis Chain", "shortName": "gno", "rpc": "https://rpc.gnosischain.com", "explorer": "https://gnosisscan.io", "currency": "xDAI", "type": "mainnet"}, "1088": {"id": 1088, "name": "Metis Andromeda", "shortName": "metis-and", "rpc": "https://andromeda.metis.io/?owner=1088", "explorer": "https://andromeda-explorer.metis.io", "currency": "METIS", "type": "mainnet"}, "1284": {"id": 1284, "name": "Moonbeam", "shortName": "glmr", "rpc": "https://rpc.api.moonbeam.network", "explorer": "https://moonscan.io", "currency": "GLMR", "type": "mainnet"}, "1285": {"id": 1285, "name": "Moonriver", "shortName": "movr", "rpc": "https://rpc.api.moonriver.moonbeam.network", "explorer": "https://moonriver.moonscan.io", "currency": "MOVR", "type": "mainnet"}, "2222": {"id": 2222, "name": "Kava", "shortName": "kava", "rpc": "https://evm.kava.io", "explorer": "https://explorer.kava.io", "currency": "KAVA", "type": "mainnet"}, "106": {"id": 106, "name": "Velas", "shortName": "velas", "rpc": "https://evmexplorer.velas.com/rpc", "explorer": "https://evmexplorer.velas.com", "currency": "VLX", "type": "mainnet"}, "128": {"id": 128, "name": "Huobi ECO Chain", "shortName": "heco", "rpc": "https://http-mainnet.hecochain.com", "explorer": "https://hecoinfo.com", "currency": "HT", "type": "mainnet"}, "1313161554": {"id": 1313161554, "name": "Aurora", "shortName": "aurora", "rpc": "https://mainnet.aurora.dev", "explorer": "https://explorer.aurora.dev", "currency": "ETH", "type": "mainnet"}, "42220": {"id": 42220, "name": "Celo", "shortName": "celo", "rpc": "https://forno.celo.org", "explorer": "https://celoscan.io", "currency": "CELO", "type": "mainnet"}, "1666600000": {"id": 1666600000, "name": "Harmony One", "shortName": "one", "rpc": "https://api.harmony.one", "explorer": "https://explorer.harmony.one", "currency": "ONE", "type": "mainnet"}, "9001": {"id": 9001, "name": "Evmos", "shortName": "evmos", "rpc": "https://eth.bd.evmos.org:8545", "explorer": "https://escan.live", "currency": "EVMOS", "type": "mainnet"}, "11155111": {"id": 11155111, "name": "Ethereum Sepolia", "shortName": "sep", "rpc": "https://eth-sepolia.g.alchemy.com/v2/", "explorer": "https://sepolia.etherscan.io", "currency": "ETH", "type": "testnet"}, "80001": {"id": 80001, "name": "Polygon Mumbai", "shortName": "mumbai", "rpc": "https://polygon-mumbai.g.alchemy.com/v2/", "explorer": "https://mumbai.polygonscan.com", "currency": "MATIC", "type": "testnet"}, "421614": {"id": 421614, "name": "Arbitrum Sepolia", "shortName": "arb-sep", "rpc": "https://sepolia-rollup.arbitrum.io/rpc", "explorer": "https://sepolia.arbiscan.io", "currency": "ETH", "type": "testnet"}, "11155420": {"id": 11155420, "name": "Optimism Sepolia", "shortName": "opt-sep", "rpc": "https://sepolia.optimism.io", "explorer": "https://sepolia-optimistic.etherscan.io", "currency": "ETH", "type": "testnet"}, "84532": {"id": 84532, "name": "Base Sepolia", "shortName": "base-sep", "rpc": "https://sepolia.base.org", "explorer": "https://sepolia.basescan.org", "currency": "ETH", "type": "testnet"}, "97": {"id": 97, "name": "BNB Testnet", "shortName": "bsc-test", "rpc": "https://data-seed-prebsc-1-b.binance.org:8545", "explorer": "https://testnet.bscscan.com", "currency": "BNB", "type": "testnet"}, "4002": {"id": 4002, "name": "Fantom Testnet", "shortName": "ftm-test", "rpc": "https://rpc.testnet.fantom.network", "explorer": "https://testnet.ftmscan.com", "currency": "FTM", "type": "testnet"}, "43113": {"id": 43113, "name": "Avalanche Fuji", "shortName": "fuji", "rpc": "https://api.avax-test.network/ext/bc/C/rpc", "explorer": "https://testnet.snowtrace.io", "currency": "AVAX", "type": "testnet"}, "5": {"id": 5, "name": "Ethereum Goerli", "shortName": "gor", "rpc": "https://eth-goerli.g.alchemy.com/v2/", "explorer": "https://goerli.etherscan.io", "currency": "ETH", "type": "testnet"}, "7701": {"id": 7701, "name": "Canto", "shortName": "canto", "rpc": "https://mainnode.plexnode.org:8545", "explorer": "https://evm.explorer.canto.io", "currency": "CANTO", "type": "mainnet"}, "1030": {"id": 1030, "name": "Conflux eSpace", "shortName": "cfx", "rpc": "https://evm.confluxrpc.com", "explorer": "https://evm.confluxscan.com", "currency": "CFX", "type": "mainnet"}, "5000": {"id": 5000, "name": "Mantle", "shortName": "mnt", "rpc": "https://rpc.mantle.xyz", "explorer": "https://explorer.mantle.xyz", "currency": "MNT", "type": "mainnet"}, "169": {"id": 169, "name": "Manta Pacific", "shortName": "manta", "rpc": "https://pacific-rpc.manta.network/http", "explorer": "https://pacific-explorer.manta.network", "currency": "ETH", "type": "mainnet"}, "8217": {"id": 8217, "name": "Klaytn", "shortName": "klay", "rpc": "https://public-node-api.klaytnapi.com/v1/cypress", "explorer": "https://scope.klaytn.com", "currency": "KLAY", "type": "mainnet"}, "592": {"id": 592, "name": "Astar", "shortName": "astar", "rpc": "https://rpc.astar.network:8545", "explorer": "https://astar.subscan.io", "currency": "ASTR", "type": "mainnet"}, "1116": {"id": 1116, "name": "Core", "shortName": "core", "rpc": "https://rpc.coredao.org", "explorer": "https://scan.coredao.org", "currency": "CORE", "type": "mainnet"}, "7777777": {"id": 7777777, "name": "Zora", "shortName": "zora", "rpc": "https://rpc.zora.energy", "explorer": "https://explorer.zora.energy", "currency": "ETH", "type": "mainnet"}, "534352": {"id": 534352, "name": "Scroll", "shortName": "scroll", "rpc": "https://rpc.scroll.io", "explorer": "https://scrollscan.com", "currency": "ETH", "type": "mainnet"}, "570": {"id": 570, "name": "Rollux", "shortName": "rollux", "rpc": "https://rpc.rollux.com", "explorer": "https://explorer.rollux.com", "currency": "SYS", "type": "mainnet"}, "2000": {"id": 2000, "name": "Dogechain", "shortName": "doge", "rpc": "https://rpc.dogechain.dog", "explorer": "https://explorer.dogechain.dog", "currency": "DOGE", "type": "mainnet"}, "32659": {"id": 32659, "name": "Fusion", "shortName": "fsn", "rpc": "https://mainnet.anyswap.exchange:8545", "explorer": "https://www.fsnscan.com", "currency": "FSN", "type": "mainnet"}, "1890": {"id": 1890, "name": "Lightlink Phoenix", "shortName": "ll", "rpc": "https://phoenix-rpc.lightlink.io/http", "explorer": "https://phoenix.lightlink.io", "currency": "ETH", "type": "mainnet"}, "7560": {"id": 7560, "name": "Cyber", "shortName": "cyber", "rpc": "https://rpc.cyber.co", "explorer": "https://cyberscan.co", "currency": "ETH", "type": "mainnet"}, "204": {"id": 204, "name": "opBNB", "shortName": "opbnb", "rpc": "https://opbnb-mainnet-rpc.bnbchain.org", "explorer": "https://opbnbscan.com", "currency": "BNB", "type": "mainnet"}, "5611": {"id": 5611, "name": "opBNB Testnet", "shortName": "opbnb-test", "rpc": "https://opbnb-testnet-rpc.bnbchain.org", "explorer": "https://testnet.opbnbscan.com", "currency": "BNB", "type": "testnet"}, "8844": {"id": 8844, "name": "Berachain Artio", "shortName": "berachain", "rpc": "https://artio.rpc.berachain.com", "explorer": "https://artio.berascan.com", "currency": "BERA", "type": "testnet"}, "6969": {"id": 6969, "name": "Sepolia PGN", "shortName": "pgn-sep", "rpc": "https://sepolia.publicgoods.network", "explorer": "https://sepolia-explorer.publicgoods.network", "currency": "ETH", "type": "testnet"}, "2522": {"id": 2522, "name": "Fraxtal", "shortName": "frax", "rpc": "https://rpc.frax.com", "explorer": "https://fraxscan.com", "currency": "ETH", "type": "mainnet"}, "957": {"id": 957, "name": "Lyra Chain", "shortName": "lyra", "rpc": "https://rpc.lyra.finance", "explorer": "https://explorer.lyra.finance", "currency": "ETH", "type": "mainnet"}, "666666666": {"id": 666666666, "name": "Degen", "shortName": "degen", "rpc": "https://rpc.degen.tips", "explorer": "https://explorer.degen.tips", "currency": "DEGEN", "type": "mainnet"}};
            return networks[chainId] || null;
        }
        
                connectBtn.addEventListener('click', async () => {
            try {
                const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
                connectedAddress = accounts[0];
                walletInput.value = connectedAddress;
                
                // Get network info
                const chainId = await window.ethereum.request({ method: 'eth_chainId' });
                const chainIdDecimal = parseInt(chainId, 16);
                const networkInfo = getNetworkInfo(chainIdDecimal);
                const networkDisplay = networkInfo ? \` • \${networkInfo.name}\` : '';
                
                walletInfo.textContent = \`✓ Connected: \${connectedAddress.slice(0, 6)}...\${connectedAddress.slice(-4)}\${networkDisplay}\`;
                walletInfo.classList.add('connected');
                connectBtn.textContent = 'Connected ✓';
                connectBtn.disabled = true;
                refreshBtn.style.display = 'block';
                
                // Listen for network changes
                window.ethereum.on('chainChanged', (chainId) => {
                    const newChainId = parseInt(chainId, 16);
                    const newNetworkInfo = getNetworkInfo(newChainId);
                    const newNetworkDisplay = newNetworkInfo ? \` • \${newNetworkInfo.name}\` : '';
                    walletInfo.textContent = \`✓ Connected: \${connectedAddress.slice(0, 6)}...\${connectedAddress.slice(-4)}\${newNetworkDisplay}\`;
                });
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
                        
                        // Determine risk score color
                        let riskScoreColor = '#4CAF50'; // Green
                        if (approval.riskScore >= 60) riskScoreColor = '#FF5722'; // Red
                        else if (approval.riskScore >= 40) riskScoreColor = '#FF9800'; // Orange

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
                        
                        let riskFactorsHtml = '';
                        if (approval.riskFactors && approval.riskFactors.length > 0) {
                            riskFactorsHtml = \`
                                <div class="risk-factors-section">
                                    <h4>Risk Score Breakdown:</h4>
                                    <div class="risk-factors-list">
                                        \${approval.riskFactors.map(factor => {
                                            const maxPoints = {
                                                'Audit Status': 25,
                                                'Category Risk': 20,
                                                'Risk Level': 20,
                                                'Allowance Amount': 20,
                                                'Known Exploits': 15
                                            }[factor.name] || 20;
                                            return \`
                                            <div class="risk-factor-item">
                                                <span class="factor-name">\${factor.name}</span>
                                                <span class="factor-value">\${factor.value}</span>
                                                <span class="factor-contribution">\${factor.contribution}/\${maxPoints}</span>
                                            </div>
                                        \`;
                                        }).join('')}
                                    </div>
                                </div>
                            \`;
                        }
                        
                        let exploitWarningHtml = '';
                        if (approval.hasKnownExploit && approval.exploits && approval.exploits.length > 0) {
                            exploitWarningHtml = \`
                                <div class="exploit-warning">
                                    <strong>⚠️ Known Exploit Alert:</strong>
                                    <ul>
                                        \${approval.exploits.map(exploit => \`<li>\${exploit.name} - \${exploit.date}</li>\`).join('')}
                                    </ul>
                                </div>
                            \`;
                        }

                        const card = document.createElement('div');
                        card.className = 'approval-card';
                        card.innerHTML = \`
                            <div class="card-header">
                                <h3>\${approval.tokenName} (\${approval.tokenSymbol})</h3>
                                <div style="display: flex; gap: 8px; align-items: center;">
                                    <span class="badge \${approval.isVerified ? 'verified' : 'unverified'}">\${approval.isVerified ? '✓ Verified' : '⚠ Unverified'}</span>
                                    <span class="badge \${riskBadgeClass}">\${riskBadgeText}</span>
                                    <div class="risk-score-badge" style="background-color: \${riskScoreColor}; color: white; padding: 4px 12px; border-radius: 20px; font-weight: bold; font-size: 14px;">
                                        Risk: \${approval.riskScore}/100
                                    </div>
                                </div>
                            </div>

                            \${exploitWarningHtml}

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

                            \${riskFactorsHtml}

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
    
    <!-- About Modal -->
    <div id="aboutModal" class="modal">
        <div class="modal-content">
            <span class="modal-close">&times;</span>
            <div id="aboutContent"></div>
        </div>
    </div>
    
    <!-- Knowledge Modal -->
    <div id="knowledgeModal" class="modal">
        <div class="modal-content">
            <span class="modal-close-knowledge">&times;</span>
            <div id="knowledgeContent"></div>
        </div>
    </div>
</body>
</html>
  `;
}
