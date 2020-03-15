import Vue from 'vue'
import Axios from 'axios'

import Kraken from '../exchanges/kraken'
import Bitmex from '../exchanges/bitmex'
import Coinex from '../exchanges/coinex'
import Huobi from '../exchanges/huobi'
import Binance from '../exchanges/binance'
import BinanceFutures from '../exchanges/binance-futures'
import Bitfinex from '../exchanges/bitfinex'
import Bitstamp from '../exchanges/bitstamp'
import Gdax from '../exchanges/gdax'
import Hitbtc from '../exchanges/hitbtc'
import Okex from '../exchanges/okex'
import Poloniex from '../exchanges/poloniex'
import Liquid from '../exchanges/liquid'
import Deribit from '../exchanges/deribit'
import Bybit from '../exchanges/bybit'
import Ftx from '../exchanges/ftx'

import store from '../services/store'

let STORED_TRADES = []

const emitter = new Vue({
  data() {
    return {
      API_URL: null,
      API_SUPPORTED_PAIRS: null,
      PROXY_URL: null,

      exchanges: [
        new Bitmex(),
        new Bitfinex(),
        new Binance(),
        new BinanceFutures(),
        new Bitstamp(),
        new Gdax(),
        new Poloniex(),
        new Kraken(),
        new Okex(),
        new Deribit(),
        new Huobi(),
        new Hitbtc(),
        new Coinex(),
        new Liquid(),
        new Bybit(),
        new Ftx()
      ],
      timestamps: {},
      queue: [],

      _pair: null,
      _fetchedMax: false,
      _fetchedTime: 0,
      _fetchedBytes: 0,
      _firstCloses: {}
    }
  },
  computed: {
    pair() {
      return store.state.pair
    },
    timeframe() {
      return store.state.timeframe
    },
    exchangesSettings() {
      return store.state.exchanges
    },
    actives() {
      return store.state.actives
    },
    showChart() {
      return store.state.showChart
    },
    chartRange() {
      return store.state.chartRange
    },
    showCounters() {
      return store.state.showCounters
    },
    countersSteps() {
      return store.state.countersSteps
    },
    isLoading() {
      return store.state.isLoading
    }
  },
  created() {
    window.emitTrade = (exchange, price, amount = 1, side = 1, type = null) => {
      exchange = exchange || 'bitmex'

      if (price === null) {
        price = this.getExchangeById(exchange).price
      }

      let trade = [exchange, +new Date(), price, amount, side ? 1 : 0, type]

      this.queue = this.queue.concat([trade])

      this.emitTrades([trade])
    }

    this.exchanges.forEach(exchange => {
      exchange.on('live_trades', trades => {
        if (!trades || !trades.length) {
          return
        }

        this.timestamps[exchange.id] = trades[0][1]

        trades = trades.sort((a, b) => a[1] - b[1])

        Array.prototype.push.apply(this.queue, trades)
        this.emitTrades(trades)
      })

      exchange.on('open', event => {
        console.log(`[socket.exchange.on.open] ${exchange.id} opened`)

        this.$emit('connected', exchange.id)
      })

      exchange.on('close', event => {
        console.log(`[socket.exchange.on.close] ${exchange.id} closed`)

        this.$emit('disconnected', exchange.id)

        if (exchange.shouldBeConnected && !this.exchangesSettings[exchange.id].disabled) {
          exchange.reconnect(this.pair)
        }
      })

      exchange.on('match', pair => {
        console.log(`[socket.exchange.on.match] ${exchange.id} matched ${pair}`)
        store.commit('setExchangeMatch', {
          exchange: exchange.id,
          match: pair
        })
      })

      exchange.on('error', event => {
        console.log(`[socket.exchange.on.error] ${exchange.id} reported an error`)
      })

      store.commit('reloadExchangeState', exchange.id)
    })
  },
  methods: {
    initialize() {
      console.log(`[sockets] initializing ${this.exchanges.length} exchange(s)`)

      if (process.env.API_URL) {
        this.API_URL = process.env.API_URL
        console.info(`[sockets] API_URL = ${this.API_URL}`)

        if (process.env.API_SUPPORTED_PAIRS) {
          this.API_SUPPORTED_PAIRS = process.env.API_SUPPORTED_PAIRS.map(a => a.toUpperCase())
          console.info(`[sockets] API_SUPPORTED_PAIRS = ${this.API_SUPPORTED_PAIRS}`)
        }
      }

      if (process.env.PROXY_URL) {
        this.PROXY_URL = process.env.PROXY_URL
        console.info(`[sockets] PROXY_URL = ${this.PROXY_URL}`)
      }

      setTimeout(this.connectExchanges.bind(this))

      setInterval(this.emitTradesAsync.bind(this), 1000)
    },
    connectExchanges(pair = null) {
      this.disconnectExchanges()

      if (!pair && !this.pair) {
        return this.$emit('alert', {
          id: `server_status`,
          type: 'error',
          title: `No pair`,
          message: `Type the name of the pair you want to watch in the pair section of the settings panel`
        })
      }

      if (pair) {
        this.pair = pair.toUpperCase()
      }

      this.queue = []
      STORED_TRADES.splice(0, STORED_TRADES.length)
      this.timestamps = {}
      this._fetchedMax = false

      console.log(`[socket.connect] connecting to ${this.pair}`)

      this.$emit('alert', {
        id: `server_status`,
        type: 'info',
        title: `Loading`,
        message: `Fetching products...`
      })

      Promise.all(this.exchanges.map(exchange => exchange.validatePair(this.pair))).then(() => {
        let validExchanges = this.exchanges.filter(exchange => exchange.valid)

        if (!validExchanges.length) {
          this.$emit('alert', {
            id: `server_status`,
            type: 'error',
            title: `No match`,
            message: `"${pair}" did not matched with any active pairs`
          })

          return
        }

        this.$emit('alert', {
          id: `server_status`,
          type: 'info',
          title: `Loading`,
          message: `${validExchanges.length} exchange(s) matched ${pair}`
        })

        if (this._pair !== this.pair) {
          this.$emit('pairing', this.pair, this.canFetch())

          this._pair = this.pair
        }

        console.log(`[socket.connect] ${validExchanges.length} successfully matched with ${this.pair}`)

        validExchanges = validExchanges.filter(exchange => !this.exchangesSettings[exchange.id].disabled)

        this.$emit('alert', {
          id: `server_status`,
          type: 'info',
          title: `Loading`,
          message: `Subscribing to ${this.pair} on ${validExchanges.length} exchange(s)`,
          delay: 1000 * 5
        })

        console.log(`[socket.connect] batch connect to ${validExchanges.map(a => a.id).join(' / ')}`)

        validExchanges.forEach(exchange => exchange.connect())
      })
    },
    disconnectExchanges() {
      console.log(`[socket.connect] disconnect exchanges asynchronously`)

      this.exchanges.forEach(exchange => exchange.disconnect())
    },
    cleanOldData() {
      if (this.isLoading) {
        return
      }

      let requiredTimeframe = 0

      if (this.showChart && this.chartRange) {
        requiredTimeframe = Math.max(requiredTimeframe, this.chartRange * 2)
      }

      const minTimestamp = Math.ceil((+new Date() - requiredTimeframe) / this.timeframe) * this.timeframe

      console.log(`[socket.clean] remove trades older than ${new Date(minTimestamp).toLocaleString()}`)

      let i

      for (i = 0; i < STORED_TRADES.length; i++) {
        if (STORED_TRADES[i][1] > minTimestamp) {
          break
        }
      }

      STORED_TRADES.splice(0, i)

      this.$emit('clean', minTimestamp)
    },
    getExchangeById(id) {
      for (let exchange of this.exchanges) {
        if (exchange.id === id) {
          return exchange
        }
      }

      return null
    },
    emitTrades(trades, event = 'trades.instant') {
      let upVolume = 0
      let downVolume = 0

      const output = trades.filter(a => {
        if (this.actives.indexOf(a[0]) === -1) {
          return false
        }

        if (a[4] > 0) {
          upVolume += a[3]
        } else {
          downVolume += a[3]
        }

        return true
      })

      this.$emit(event, output, upVolume, downVolume)
    },
    emitTradesAsync() {
      if (!this.queue.length) {
        return
      }

      if (this.showChart) {
        Array.prototype.push.apply(STORED_TRADES, this.queue)
      }

      this.emitTrades(this.queue, 'trades.queued')

      this.queue = []
    },
    canFetch() {
      return this.API_URL && (!this.API_SUPPORTED_PAIRS || this.API_SUPPORTED_PAIRS.indexOf(this.pair) !== -1)
    },
    getApiUrl(from, to) {
      let url = this.API_URL

      url = url.replace(/\{from\}/, from)
      url = url.replace(/\{to\}/, to)
      url = url.replace(/\{timeframe\}/, this.timeframe)
      url = url.replace(/\{pair\}/, this.pair.toLowerCase())
      url = url.replace(/\{exchanges\}/, this.actives.join('+'))

      return url
    },
    fetchRange(range, clear = false) {
      if (clear) {
        this._fetchedMax = false
      }

      if (this.isLoading || !this.canFetch()) {
        return Promise.resolve(null)
      }

      const now = +new Date()

      const minData = STORED_TRADES.length ? STORED_TRADES[0][1] : now

      let promise
      let from = now - range
      let to = minData

      from = Math.ceil(from / this.timeframe) * this.timeframe
      to = Math.ceil(to / this.timeframe) * this.timeframe

      console.log(
        `[socket.fetchRange] minData: ${new Date(minData).toLocaleString()}, from: ${new Date(from).toLocaleString()}, to: ${to}`,
        this._fetchedMax ? '(FETCHED MAX)' : ''
      )

      if (!this._fetchedMax && to - from >= 60000 && from < minData) {
        console.info(
          `[socket.fetchRange]`,
          `FETCH NEEDED\n\n\tcurrent time: ${new Date(now).toLocaleString()}\n\tfrom: ${new Date(from).toLocaleString()}\n\tto: ${new Date(
            to
          ).toLocaleString()} (${STORED_TRADES.length ? 'using first trade as base' : 'using now for reference'})`
        )

        promise = this.fetchHistoricalData(from, to)
      } else {
        promise = Promise.resolve()
      }

      return promise
    },
    fetchHistoricalData(from, to) {
      const url = this.getApiUrl(from, to)

      if (this.lastFetchUrl === url) {
        return Promise.resolve()
      }

      this.lastFetchUrl = url

      store.commit('toggleLoading', true)

      this.$emit('fetchStart', to - from)

      return new Promise((resolve, reject) => {
        Axios.get(url, {
          onDownloadProgress: e => {
            this.$emit('loadingProgress', {
              loaded: e.loaded,
              total: e.total,
              progress: e.loaded / e.total
            })

            this._fetchedBytes += e.loaded
          }
        })
          .then(response => {
            if (!response.data || !response.data.results.length) {
              return resolve()
            }

            let data = response.data.results

            data = data.map(a => {
              a[1] = +a[1]
              a[2] = +a[2]
              a[3] = +a[3]
              a[4] = +a[4]

              return a
            })

            if (!STORED_TRADES.length) {
              console.log(`[socket.fetch] set socket.trades (${data.length} trades)`)

              Array.prototype.push.apply(STORED_TRADES, data)
            } else {
              const prepend = data.filter(trade => trade[1] <= STORED_TRADES[0][1])
              const append = data.filter(trade => trade[1] >= STORED_TRADES[STORED_TRADES.length - 1][1])

              if (prepend.length) {
                console.log(`[fetch] prepend ${prepend.length} ticks`)
                STORED_TRADES = prepend.concat(STORED_TRADES)
              }

              if (append.length) {
                console.log(`[fetch] append ${append.length} ticks`)
                STORED_TRADES = STORED_TRADES.concat(append)
              }
            }

            this.$emit('historical', data, from, to)

            resolve({
              format: format,
              data: data,
              from: from,
              to: to
            })
          })
          .catch(err => {
            this._fetchedMax = true

            err &&
              this.$emit('alert', {
                type: 'error',
                title: `Unable to retrieve history`,
                message: err.response && err.response.data && err.response.data.error ? err.response.data.error : err.message,
                id: `fetch_error`
              })

            reject()
          })
          .then(() => {
            this._fetchedTime += to - from

            this.$emit('fetchEnd', to - from)

            store.commit('toggleLoading', false)
          })
      })
    },
    getCurrentTimestamp() {
      return +new Date()
    },
    getInitialPrices() {
      if (!STORED_TRADES.length) {
        return this._firstCloses
      }

      const closesByExchanges = this.exchanges.reduce((obj, exchange) => {
        obj[exchange.id] = null

        return obj
      }, {})

      if (!Object.keys(closesByExchanges).length) {
        return closesByExchanges
      }

      let gotAllCloses = false

      for (let trade of STORED_TRADES) {
        if (typeof closesByExchanges[trade[0]] === 'undefined' || closesByExchanges[trade[0]]) {
          continue
        }

        closesByExchanges[trade[0]] = trade[2]

        if (
          gotAllCloses ||
          !Object.keys(closesByExchanges)
            .map(id => closesByExchanges[id])
            .filter(close => close === null).length
        ) {
          gotAllCloses = true

          break
        }
      }

      for (let exchange in closesByExchanges) {
        if (closesByExchanges[exchange] === null) {
          delete closesByExchanges[exchange]
        }
      }

      this._firstCloses = closesByExchanges

      return closesByExchanges
    },
    getTrades() {
      return STORED_TRADES
    },
    getTradesCount() {
      return STORED_TRADES.length
    },
    getFirstTimestamp() {
      return STORED_TRADES[0] ? STORED_TRADES[0][1] : null
    }
  }
})

export default emitter
