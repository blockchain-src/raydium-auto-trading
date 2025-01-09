import { NATIVE_MINT, getMint } from '@solana/spl-token'
import { Raydium, TxVersion } from '@raydium-io/raydium-sdk-v2'
import dotenv from 'dotenv'
import { Connection, PublicKey, Keypair } from '@solana/web3.js'
import bs58 from 'bs58'

dotenv.config()

const { PRIVATE_KEY, BUY_THRESHOLD, SELL_THRESHOLD, BUY_AMOUNT, SELL_AMOUNT, TOKEN_MINT_ADDRESS, POOL_ID } = process.env

if (!PRIVATE_KEY || !TOKEN_MINT_ADDRESS || !POOL_ID) {
  throw new Error('缺少必要的环境变量，请检查 .env 文件！')
}

const privateKey = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY))
const connection = new Connection('https://solana-mainnet.g.alchemy.com/v2/KEGJ3Gr9ORW_w5a0iNvW20PS9eRbKj3X')

async function monitorTokenMarketCap() {
  console.log('加载 Raydium SDK...')

  const raydium = await Raydium.load({
    connection,
    owner: privateKey,
    cluster: 'mainnet',
    disableFeatureCheck: true,
  })

  console.log('加载交易池基本信息...')
  const poolData = await raydium.tradeV2.fetchRoutePoolBasicInfo()
  const monitoredPool = poolData.ammPools.find((pool) => pool.id.toBase58() === POOL_ID)

  if (!monitoredPool) {
    throw new Error('指定的交易池未找到，请检查 POOL_ID 是否正确！')
  }

  console.log(`正在监听交易池: ${monitoredPool.id.toBase58()}`)

  const buyThreshold = parseFloat(BUY_THRESHOLD || '0')
  const sellThreshold = parseFloat(SELL_THRESHOLD || '0')

  if (isNaN(buyThreshold) || isNaN(sellThreshold)) {
    throw new Error('BUY_THRESHOLD 或 SELL_THRESHOLD 配置错误，请检查 .env 文件！')
  }

  setInterval(async () => {
    try {
      console.log('获取当前代币市值...')
      const marketCap = await fetchTokenMarketCap(monitoredPool)
      console.log(`当前代币市值: ${marketCap.toLocaleString()} USD`)

      if (marketCap >= buyThreshold) {
        console.log('市值达到买入阈值，执行买入操作...')
        await executeTrade(raydium, monitoredPool, 'buy', parseFloat(BUY_AMOUNT || '0'))
      } else if (marketCap <= sellThreshold) {
        console.log('市值低于卖出阈值，执行卖出操作...')
        await executeTrade(raydium, monitoredPool, 'sell', parseFloat(SELL_AMOUNT || '0'))
      } else {
        console.log('市值未达到买入或卖出阈值，无操作。')
      }
    } catch (error) {
      console.error('监听过程中出错:', error)
    }
  }, 30000)
}

async function fetchTokenMarketCap(pool: any) {
  try {
    console.log('获取代币供应量和价格...')
    const mintInfo = await getMint(connection, new PublicKey(TOKEN_MINT_ADDRESS!))
    const totalSupply = Number(mintInfo.supply) / Math.pow(10, mintInfo.decimals)

    const price = await fetchTokenPrice(pool)
    const marketCap = totalSupply * price

    console.log(`总供应量: ${totalSupply}, 当前价格: ${price}, 市值: ${marketCap}`)
    return marketCap
  } catch (error) {
    console.error('获取代币市值时出错:', error)
    throw error
  }
}

async function fetchTokenPrice(pool: any) {
  try {
    if (typeof pool.getPrice !== 'function') {
      throw new Error('交易池对象不支持获取价格，请检查 SDK 版本！')
    }
    const price = pool.getPrice()
    console.log(`当前交易池价格: ${price}`)
    return price
  } catch (error) {
    console.error('获取价格时出错:', error)
    throw error
  }
}

async function executeTrade(raydium: Raydium, pool: any, type: 'buy' | 'sell', amount: number) {
  try {
    console.log(`${type === 'buy' ? '买入' : '卖出'}操作开始，金额: ${amount}`)

    const inputMint = type === 'buy' ? NATIVE_MINT : new PublicKey(TOKEN_MINT_ADDRESS!)
    const outputMint = type === 'buy' ? new PublicKey(TOKEN_MINT_ADDRESS!) : NATIVE_MINT

    const routes = raydium.tradeV2.getAllRoute({
      inputMint,
      outputMint,
      clmmPools: [],
      ammPools: [pool],
      cpmmPools: [],
    })

    const swapRoutesData = await raydium.tradeV2.fetchSwapRoutesData({
      routes,
      inputMint,
      outputMint,
    })

    console.log('交易路径数据:', swapRoutesData)

    const swapData = Array.isArray(swapRoutesData) ? swapRoutesData : []
    if (!swapData || swapData.length === 0) {
      throw new Error('未找到有效的交易路径！')
    }

    const { execute } = await raydium.tradeV2.swap({
      routeProgram: new PublicKey('RouteProgramAddress'), // 替换为实际值
      txVersion: TxVersion.V0,
      swapInfo: swapData[0],
      ownerInfo: { associatedOnly: true, checkCreateATAOwner: true },
      computeBudgetConfig: { units: 600000, microLamports: 465915 },
    })

    const { txIds } = await execute({ sequentially: true })
    txIds.forEach((txId) => console.log(`交易成功，详情: https://explorer.solana.com/tx/${txId}`))
  } catch (error) {
    console.error(`${type === 'buy' ? '买入' : '卖出'}操作失败:`, error)
    throw error
  }
}

monitorTokenMarketCap().catch((error) => console.error('启动过程中发生错误:', error))
