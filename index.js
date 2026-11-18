const express = require('express');
const axios = require('axios');
const { ethers } = require('ethers');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'ussd_secret_123';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const NGN_RATE = 1600;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const RPC_URL = process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || '0x0fEC3876f7BE924472156Cb9cB39E60cBF3a3C89';
const TREASURY_PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY;

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)'
];

let ussdContract = null;
if (TREASURY_PRIVATE_KEY) {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const treasuryWallet = new ethers.Wallet(TREASURY_PRIVATE_KEY, provider);
  ussdContract = new ethers.Contract(CONTRACT_ADDRESS, ERC20_ABI, treasuryWallet);
}

async function settleOnChain(recipientPhone, recipientAddress, amount) {
  if (!ussdContract) return;
  try {
    const decimals = await ussdContract.decimals();
    const weiAmount = ethers.parseUnits(amount.toString(), decimals);
    const tx = await ussdContract.transfer(recipientAddress, weiAmount);
    console.log(`On-chain tx sent: ${tx.hash}`);
    await supabase
      .from('wallets')
      .update({ last_tx: tx.hash })
      .eq('phone', recipientPhone);
  } catch (err) {
    console.error('On-chain settlement error:', err.message);
  }
}

async function logTransaction(phone, type, amountUssd, amountNgn = null, bankAccount = null) {
  try {
    await supabase.from('transactions').insert({
      phone,
      type,
      amount_ussd: amountUssd,
      amount_ngn: amountNgn,
      bank_account: bankAccount
    });
  } catch (err) {
    console.error('Tx log error:', err.message);
  }
}

async function getOrCreateWallet(phone) {
  const { data } = await supabase
    .from('wallets')
    .select('*')
    .eq('phone', phone)
    .single();

  if (data) return data;

  const wallet = ethers.Wallet.createRandom();
  const newUser = {
    phone,
    address: wallet.address,
    pin: null,
    balance: 100
  };
  await supabase.from('wallets').insert(newUser);
  return newUser;
}

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const entry = req.body.entry?.at(0);
    const message = entry?.changes?.at(0)?.value?.messages?.at(0);
    if (!message || !message.text) return;

    const from = message.from;
    const text = message.text.body.trim();
    const user = await getOrCreateWallet(from);

    let reply = '';
    if (text.toLowerCase().includes('balance')) {
      reply = `💵 *USSD Dollar Wallet*\nPhone: +${from}\nBalance: *${Number(user.balance).toFixed(2)} USSD* ($${Number(user.balance).toFixed(2)})\nWallet: \`${user.address}\``;
    } else if (text.toLowerCase().startsWith('send')) {
      const parts = text.split(' ');
      const amount = parseFloat(parts.at(1));
      const recipient = parts.at(2)?.replace('+', '');
      if (!amount || amount <= 0 || !recipient) {
        reply = `❌ Format: *Send 10 +2348012345678*`;
      } else if (amount > Number(user.balance)) {
        reply = `❌ Insufficient funds. Your balance is *${Number(user.balance).toFixed(2)} USSD*.`;
      } else {
        const target = await getOrCreateWallet(recipient);
        const newSenderBal = Number(user.balance) - amount;
        const newTargetBal = Number(target.balance) + amount;
        await supabase.from('wallets').update({ balance: newSenderBal }).eq('phone', from);
        await supabase.from('wallets').update({ balance: newTargetBal }).eq('phone', recipient);
        await logTransaction(from, 'SEND', amount, amount * NGN_RATE, recipient);
        settleOnChain(recipient, target.address, amount);
        reply = `✅ Sent *${amount.toFixed(2)} USSD* to +${recipient}!\nNew Balance: *${newSenderBal.toFixed(2)} USSD*`;
      }
    } else {
      reply = `👋 Welcome to *USSD Coin ($USSD)*!\nReply with:\n• *Balance*\n• *Send 10 +2348012345678*`;
    }

    if (WHATSAPP_TOKEN && PHONE_NUMBER_ID) {
      await axios.post(
      `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: 'whatsapp',
          to: from,
          text: { body: reply }
        },
        { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
      );
    }
  } catch (err) {
    console.error('Webhook error:', err.message);
  }
});

app.post('/ussd', async (req, res) => {
  try {
    const { phoneNumber, text } = req.body;
    const cleanPhone = (phoneNumber || '').replace('+', '');
    const user = await getOrCreateWallet(cleanPhone);

    let response = '';

    if (!user.pin) {
      if (!text || text === '') {
        response = `CON Welcome to USSD Dollar ($USSD)!\nCreate a 4-digit PIN to secure your wallet:`;
      } else if (/^\d{4}$/.test(text.trim())) {
        await supabase.from('wallets').update({ pin: text.trim() }).eq('phone', cleanPhone);
        response = `END PIN created successfully! Dial *384*51117# again to access your 100.00 USSD wallet.`;
      } else {
        response = `END Invalid PIN. Dial *384*51117# and enter 4 digits.`;
      }
    } else if (!text || text === '') {
      response = `CON USSD Dollar ($USSD)\n1. Check Balance\n2. Send $USSD\n3. Wallet & Last Tx\n4. Buy / Cash Out (NGN)`;
    } else if (text === '1') {
      const ngnVal = (Number(user.balance) * NGN_RATE).toLocaleString();
      response = `END Balance: ${Number(user.balance).toFixed(2)} USSD ($${Number(user.balance).toFixed(2)})\nEst. Value: NGN ${ngnVal}`;
    } else if (text === '2') {
      response = `CON Enter recipient phone number (e.g. 2348012345678):`;
    } else if (text.startsWith('2*')) {
      const parts = text.split('*');
      if (parts.length === 2) {
        response = `CON Enter amount in USSD to send:`;
      } else if (parts.length === 3) {
        response = `CON Enter your 4-digit PIN to confirm:`;
      } else if (parts.length === 4) {
        const recipient = parts.at(1)?.replace('+', '');
        const amount = parseFloat(parts.at(2));
        const enteredPin = parts.at(3)?.trim();

        if (enteredPin !== user.pin) {
          response = `END Incorrect PIN. Transaction cancelled.`;
        } else if (amount > 0 && amount <= Number(user.balance)) {
          const target = await getOrCreateWallet(recipient);
          const newSenderBal = Number(user.balance) - amount;
          const newTargetBal = Number(target.balance) + amount;

          await supabase.from('wallets').update({ balance: newSenderBal }).eq('phone', cleanPhone);
          await supabase.from('wallets').update({ balance: newTargetBal }).eq('phone', recipient);
          await logTransaction(cleanPhone, 'SEND', amount, amount * NGN_RATE, recipient);

          settleOnChain(recipient, target.address, amount);

          response = `END Sent ${amount.toFixed(2)} USSD to +${recipient}!\nSettling on Sepolia...\nNew Balance: ${newSenderBal.toFixed(2)} USSD`;
        } else {
          response = `END Invalid amount or insufficient balance.`;
        }
      }
    } else if (text === '3') {
      const txInfo = user.last_tx ? `\nLast Tx: ${user.last_tx.slice(0, 14)}...` : '';
      response = `END Wallet: ${user.address}${txInfo}`;
    } else if (text === '4') {
      response = `CON Naira On/Off-Ramp (1 USSD = NGN ${NGN_RATE})\n1. Buy $USSD with Naira\n2. Cash Out $USSD to Bank`;
    } else if (text === '4*1') {
      response = `CON Enter amount in Naira (NGN) to deposit (e.g. 16000):`;
    } else if (text.startsWith('4*1*')) {
      const parts = text.split('*');
      const ngnAmount = parseFloat(parts.at(2));
      if (ngnAmount >= 1600) {
        const ussdMinted = ngnAmount / NGN_RATE;
        const newBal = Number(user.balance) + ussdMinted;
        await supabase.from('wallets').update({ balance: newBal }).eq('phone', cleanPhone);
        await logTransaction(cleanPhone, 'BUY_NGN', ussdMinted, ngnAmount, 'PAYSTACK_VIRTUAL_ACCT');
        settleOnChain(cleanPhone, user.address, ussdMinted);
        response = `END Credited ${ussdMinted.toFixed(2)} USSD (NGN ${ngnAmount.toLocaleString()})!\nSettling on Sepolia...\nNew Balance: ${newBal.toFixed(2)} USSD`;
      } else {
        response = `END Minimum deposit is NGN 1,600 (1.00 USSD).`;
      }
    } else if (text === '4*2') {
      response = `CON Enter amount in $USSD to cash out:`;
    } else if (text.startsWith('4*2*')) {
      const parts = text.split('*');
      if (parts.length === 3) {
        response = `CON Enter 10-digit Nigerian Bank Account No:`;
      } else if (parts.length === 4) {
        response = `CON Enter your 4-digit PIN to confirm payout:`;
      } else if (parts.length === 5) {
        const ussdAmount = parseFloat(parts.at(2));
        const bankAcct = parts.at(3)?.trim();
        const enteredPin = parts.at(4)?.trim();

        if (enteredPin !== user.pin) {
          response = `END Incorrect PIN. Cash out cancelled.`;
        } else if (!/^\d{10}$/.test(bankAcct)) {
          response = `END Invalid account number. Must be 10 digits.`;
        } else if (ussdAmount > 0 && ussdAmount <= Number(user.balance)) {
          const ngnPayout = ussdAmount * NGN_RATE;
          const newBal = Number(user.balance) - ussdAmount;
          await supabase.from('wallets').update({ balance: newBal }).eq('phone', cleanPhone);
          await logTransaction(cleanPhone, 'CASHOUT_NGN', ussdAmount, ngnPayout, bankAcct);
          response = `END Cash Out Initiated!\nNGN ${ngnPayout.toLocaleString()} sent to Acct ${bankAcct}.\nNew Balance: ${newBal.toFixed(2)} USSD`;
        } else {
          response = `END Invalid amount or insufficient balance.`;
        }
      }
    } else {
      response = `END Invalid selection.`;
    }

    res.set('Content-Type', 'text/plain');
    res.send(response);
  } catch (err) {
    console.error('USSD error:', err.message);
    res.set('Content-Type', 'text/plain');
    res.send('END Temporary service error. Please try again.');
  }
});

app.get('/', (req, res) => res.send('USSD Coin Bot Server is Live!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
