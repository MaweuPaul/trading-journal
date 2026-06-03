//+------------------------------------------------------------------+
//|                                             TradeScreenshot.mq5  |
//|                                         TradeJournal MT5 EA      |
//|                                    github.com/your-repo-here     |
//+------------------------------------------------------------------+
#property copyright "Copyright 2026, TradeJournal"
#property link      "https://github.com/your-repo-here"
#property version   "1.01"
#property description "MT5 Expert Advisor that automatically captures chart screenshots on position open and close events. Screenshots are saved to MQL5/Files/ and picked up by the sync.py pipeline."

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
  {
   Print("🚀 TradeScreenshot EA initialized. Ready to auto-capture chart screenshots!");
   return(INIT_SUCCEEDED);
  }

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   Print("🔌 TradeScreenshot EA deinitialized.");
  }

//+------------------------------------------------------------------+
//| OnTradeTransaction event handler                                 |
//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction& trans,
                        const MqlTradeRequest& request,
                        const MqlTradeResult& result)
  {
   // Listen for DEAL_ADD transactions — fired when a deal (entry or exit) is completed
   if(trans.type == TRADE_TRANSACTION_DEAL_ADD)
     {
      ulong deal_ticket = trans.deal;

      // Select the deal from history to query its properties
      if(HistoryDealSelect(deal_ticket))
        {
         long position_id = HistoryDealGetInteger(deal_ticket, DEAL_POSITION_ID);
         long entry_type  = HistoryDealGetInteger(deal_ticket, DEAL_ENTRY);
         string symbol    = HistoryDealGetString(deal_ticket, DEAL_SYMBOL);

         // File naming convention: {position_id}_{type}.png
         // This matches what the sync.py pipeline expects.
         if(entry_type == DEAL_ENTRY_IN)
           {
            string filename = IntegerToString(position_id) + "_entry.png";
            if(ChartScreenShot(0, filename, 1920, 1080))
              {
               Print("📸 Entry screenshot saved: " + filename + " | Symbol: " + symbol);
              }
            else
              {
               Print("❌ Failed to capture entry screenshot: " + filename + " | Error: " + IntegerToString(GetLastError()));
              }
           }
         else if(entry_type == DEAL_ENTRY_OUT)
           {
            string filename = IntegerToString(position_id) + "_exit.png";
            if(ChartScreenShot(0, filename, 1920, 1080))
              {
               Print("📸 Exit screenshot saved: " + filename + " | Symbol: " + symbol);
              }
            else
              {
               Print("❌ Failed to capture exit screenshot: " + filename + " | Error: " + IntegerToString(GetLastError()));
              }
           }
        }
     }
  }
//+------------------------------------------------------------------+
