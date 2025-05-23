import { OrderBookLevelState } from './OrderBookLevel';

const EnumLevelProperty = Object.freeze({
  symbol: 0,
  price: 1,
  side: 2,
  qty: 3,
  extraState: 4,
});

export interface OrderBookOptions {
  checkTimestamps?: boolean;
  maxDepth?: number;
  /** Whether to console.log when a snapshot or delta is processed */
  traceLog?: boolean;
}

/**
 * Storage helper to store/track/manipulate the current state of an symbol's orderbook
 * @class OrderBook
 */
export class OrderBook<ExtraStateType = unknown> {
  symbol: string;
  book: OrderBookLevelState<ExtraStateType>[];
  shouldCheckTimestamps: boolean;
  lastUpdateTimestamp: number;
  maxDepth: number;

  constructor(symbol: string, options: OrderBookOptions = {}) {
    this.symbol = symbol;
    this.book = [];

    this.shouldCheckTimestamps = options.checkTimestamps === true;
    this.lastUpdateTimestamp = new Date().getTime();
    this.maxDepth = options.maxDepth || 250;
  }

  /**
   * Returns a cloned copy of the current orderbook state
   */
  public getBookState(): OrderBookLevelState<ExtraStateType>[] {
    return structuredClone(this.book);
  }

  /**
   * @public Process orderbook snapshot, replacing existing book in memory
   * @param {OrderBookLevelState[]} data current orderbook snapshot represented as array, where each child element is a level in the orderbook
   * @param {number} timestamp
   */
  public handleSnapshot(
    data: OrderBookLevelState<ExtraStateType>[],
    timestamp: number = Date.now(),
  ): this {
    this.checkTimestamp(timestamp);
    this.book = data;
    return this.trimToMaxDepth().sort().trackDidUpdate(timestamp);
  }

  /**
   * @public Process orderbook delta change, either deleting, updating or inserting level data into the existing book. Price is used on each level to find existing index in tracked book state.
   *
   * @param {Array} [deleteDelta=[]] levels to delete
   * @param {Array} [upsertDelta=[]] levels to update (will automatically insert if level does not exist)
   * @param {Array} [insertDelta=[]] levels to insert
   * @param {number} timestamp
   */
  public handleDelta(
    deleteDelta: OrderBookLevelState[] = [],
    upsertDelta: OrderBookLevelState[] = [],
    insertDelta: OrderBookLevelState[] = [],
    timestamp: number = Date.now(),
  ): this {
    this.checkTimestamp(timestamp);

    deleteDelta.forEach((level) => {
      const existingIndex = this.findIndexForSlice(level);
      if (existingIndex !== -1) {
        this.book.splice(existingIndex, 1);
      }
    });

    upsertDelta.forEach((level) => {
      const existingIndex = this.findIndexForSlice(level);
      if (existingIndex !== -1) {
        this.replaceLevelAtIndex(existingIndex, level);
      } else {
        this.insertLevel(level);
      }
    });

    insertDelta.forEach((level) => {
      const existingIndex = this.findIndexForSlice(level);
      if (existingIndex !== -1) {
        this.replaceLevelAtIndex(existingIndex, level);
      }
      this.insertLevel(level);
    });

    return this.trimToMaxDepth().sort().trackDidUpdate(timestamp);
  }

  /**
   * @private replace item at index, mutating existing book store
   */
  private replaceLevelAtIndex(i: number, level: OrderBookLevelState): this {
    this.book.splice(i, 1, level);
    return this;
  }

  /**
   * @private insert item, mutating existing book store
   */
  private insertLevel(level: OrderBookLevelState): this {
    this.book.push(level);
    return this;
  }

  /**
   * @private find index of level in book, using "price" property as primary key
   * @param {object} level
   * @returns {number} index of level in book, if found, else -1
   */
  private findIndexForSlice(level: OrderBookLevelState): number {
    return this.book.findIndex(
      (e) => e[EnumLevelProperty.price] === level[EnumLevelProperty.price],
    );
  }

  /**
   * @public throw error if current timestamp is older than last updated timestamp
   * @param {number} timestamp
   */
  public checkTimestamp(timestamp: number) {
    if (!this.shouldCheckTimestamps) {
      return false;
    }
    if (this.lastUpdateTimestamp > timestamp) {
      throw new Error(
        `Received data older than last tick: ${{
          lastUpdate: this.lastUpdateTimestamp,
          currentUpdate: timestamp,
        }}`,
      );
    }
  }

  /** Sort orderbook in memory, lowest price last, highest price first */
  private sort(): this {
    // sorts with lowest price last, highest price first
    this.book.sort(
      (a, b) => b[EnumLevelProperty.price] - a[EnumLevelProperty.price],
    );
    return this;
  }

  /** trim orderbook in place to max depth, evenly across both sides */
  private trimToMaxDepth(): this {
    const book = this.book;
    const maxDepth = this.maxDepth;
    if (book.length <= maxDepth) {
      return this;
    }

    const count = book.reduce(
      (acc, level) => {
        if (level[EnumLevelProperty.side] === 'Sell') {
          acc.sells++;
          return acc;
        }
        acc.buys++;
        return acc;
      },
      { buys: 0, sells: 0 },
    );

    const maxPerSide = +(maxDepth / 2).toFixed(0);

    const buysToTrim = count.buys - maxPerSide;
    const sellsToTrim = count.sells - maxPerSide;

    this.sort()
      .trimSideCount(buysToTrim, false)
      .trimSideCount(sellsToTrim, true);

    return this;
  }

  /**
   * Trim edges of orderbook to total target
   *
   * @param {number} [totalToTrim=0]
   * @param {boolean} shouldTrimTop - if true, trim from array beginning (top = sells) else from array end (bottom = buys)
   */
  private trimSideCount(
    totalToTrim: number = 0,
    shouldTrimTop?: boolean,
  ): this {
    if (totalToTrim <= 0) {
      return this;
    }

    const book = this.book;
    if (shouldTrimTop) {
      book.splice(0, totalToTrim);
      return this;
    }

    book.splice(book.length - totalToTrim - 1, totalToTrim);
    return this;
  }

  /** Track last updated timestamp */
  private trackDidUpdate(timestamp: number = new Date().getTime()): this {
    this.lastUpdateTimestamp = timestamp;
    return this;
  }

  /** dump orderbook state to console */
  public print() {
    // console.clear();
    console.log(
      `---------- ${
        this.symbol
      } ask:bid ${this.getBestAsk()}:${this.getBestBid()} & spread: ${this.getSpreadBasisPoints()?.toFixed(
        5,
      )} bp`,
    );

    // Map the book to a new format for console.table
    const formattedBook = this.book.map((level) => ({
      symbol: level[EnumLevelProperty.symbol],
      price: level[EnumLevelProperty.price],
      side: level[EnumLevelProperty.side],
      qty: level[EnumLevelProperty.qty],
    }));
    console.table(formattedBook);

    return this;
  }

  /** empty current orderbook store to free memory */
  public reset() {
    this.book = [];
    return this;
  }

  /**
   * get lowest sell order
   * @param {number} [offset=0] offset from array centre (should be positive)
   * @returns {number} lowest seller price
   */
  public getBestAsk(offset: number = 0): number | null {
    const sellSide = this.book.filter(
      (e) => e[EnumLevelProperty.side] === 'Sell',
    );
    const index = sellSide.length - 1 - offset;
    const bottomSell = sellSide[Math.abs(index)];
    return bottomSell ? bottomSell[EnumLevelProperty.price] : null;
  }

  /**
   * get highest buy order price
   * @param {number} [offset=0] offset from array centre (should be positive)
   * @returns {number} highest buyer price
   */
  public getBestBid(offset: number = 0): number | null {
    const buySide = this.book.filter(
      (e) => e[EnumLevelProperty.side] === 'Buy',
    );
    const topBuy = buySide[Math.abs(offset)];
    return topBuy ? topBuy[EnumLevelProperty.price] : null;
  }

  /**
   * get current bid/ask spread percentage
   * @param {number} [n=0] offset from centre of book
   * @returns {number} percentage spread between best bid & ask
   */
  public getSpreadPercent(n = 0): number | null {
    const ask = this.getBestAsk(n);
    const bid = this.getBestBid(n);

    if (!bid || !ask) {
      return null;
    }
    return (1 - bid / ask) * 100;
  }

  /**
   * get current bid/ask spread in basis points
   * @param {number} [n=0] offset from centre of book
   * @returns {number} spread between best bid & ask in basis points
   */
  public getSpreadBasisPoints(n = 0): number | null {
    const ask = this.getBestAsk(n);
    const bid = this.getBestBid(n);

    if (!bid || !ask) {
      return null;
    }
    // calculate spread in basis points
    return (1 - bid / ask) * 10000;
  }

  /**
   * Calculate expected slippage for a market order of a given size
   * @param {number} baseOrderSize - The size of the order in base units
   * @param {string} side - 'Buy' or 'Sell' side of the order
   * @returns {{ executionPrice: number, slippagePercent: number, slippageBasisPoints: number } | null} - The expected execution price and slippage
   */
  public getEstimatedSlippage(baseOrderSize: number, side: 'Buy' | 'Sell'): { executionPrice: number, slippagePercent: number, slippageBasisPoints: number } | null {
    if (baseOrderSize <= 0) {
      throw new Error('Order size is not positive!');
    }

    // Filter the book to get only the levels for the relevant side
    // For a buy order, we need the sell levels; for a sell order, we need the buy levels
    const relevantLevels = this.book.filter(
      (level) => level[EnumLevelProperty.side] === (side === 'Buy' ? 'Sell' : 'Buy')
    );
    
    if (relevantLevels.length === 0) {
      throw new Error('No relevant levels found in orderbook!');
    }

    // Sort the levels by price (ascending for buy orders, descending for sell orders)
    const sortedLevels = [...relevantLevels].sort((a, b) => {
      return side === 'Buy'
        ? a[EnumLevelProperty.price] - b[EnumLevelProperty.price] // Buy orders fill from lowest ask to highest
        : b[EnumLevelProperty.price] - a[EnumLevelProperty.price]; // Sell orders fill from highest bid to lowest
    });

    let remainingSize = baseOrderSize;
    let totalCost = 0;

    // Simulate filling the order level by level
    for (const level of sortedLevels) {
      const price = level[EnumLevelProperty.price];
      const availableQty = level[EnumLevelProperty.qty];
      
      const fillQty = Math.min(remainingSize, availableQty);
      totalCost += fillQty * price;
      remainingSize -= fillQty;
      
      if (remainingSize <= 0) {
        break;
      }
    }

    // If we couldn't fill the entire order, return null
    if (remainingSize > 0) {
      throw new Error('Could not fill the entire order');
    }

    // Calculate the average execution price
    const executionPrice = totalCost / baseOrderSize;
    
    // Calculate slippage relative to the best price
    const bestPrice = side === 'Buy' ? this.getBestAsk() : this.getBestBid();
    
    if (!bestPrice) {
      return null;
    }
    
    // Calculate slippage percentage
    const slippagePercent = side === 'Buy'
      ? ((executionPrice / bestPrice) - 1) * 100 // For buys, execution price is higher than best price
      : ((bestPrice / executionPrice) - 1) * 100; // For sells, execution price is lower than best price
    
    // Calculate slippage in basis points
    const slippageBasisPoints = slippagePercent * 100;

    return {
      executionPrice,
      slippagePercent,
      slippageBasisPoints
    };
  }
}
