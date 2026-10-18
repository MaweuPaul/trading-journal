//+------------------------------------------------------------------+
//|                                                  NewsExport.mq5  |
//|                                         TradeJournal MT5 script  |
//+------------------------------------------------------------------+
#property copyright "Copyright 2026, TradeJournal"
#property version   "1.00"
#property description "Exports MT5's economic calendar (high and medium impact, every major currency) to a CSV for TradeJournal's backtest news. Run once; upload the file on the Backtest page (Indicators -> Import MT5 news history)."
#property script_show_inputs

input datetime InpFrom       = D'2024.01.01';                       // Export from
input string   InpCurrencies = "USD,EUR,GBP,JPY,AUD,NZD,CAD,CHF,CNY"; // Currencies (one file covers every pair)
input string   InpFile       = "tradejournal_news.csv";             // File name (saved in MQL5\Files)

//+------------------------------------------------------------------+
//| A value as the calendar shows it: 206K, 3.4%, -0.2                |
//+------------------------------------------------------------------+
string FormatValue(const double value, const MqlCalendarEvent &event)
  {
   string text = DoubleToString(value, (int)event.digits);
   switch(event.multiplier)
     {
      case CALENDAR_MULTIPLIER_THOUSANDS: text += "K"; break;
      case CALENDAR_MULTIPLIER_MILLIONS:  text += "M"; break;
      case CALENDAR_MULTIPLIER_BILLIONS:  text += "B"; break;
      case CALENDAR_MULTIPLIER_TRILLIONS: text += "T"; break;
      default: break;
     }
   if(event.unit == CALENDAR_UNIT_PERCENT)
      text += "%";
   return text;
  }

//+------------------------------------------------------------------+
//| A CSV field, quoted when it holds a comma or a quote              |
//+------------------------------------------------------------------+
string CsvField(string text)
  {
   if(StringFind(text, ",") < 0 && StringFind(text, "\"") < 0)
      return text;
   StringReplace(text, "\"", "\"\"");
   return "\"" + text + "\"";
  }

//+------------------------------------------------------------------+
//| One currency's events in [from, to). MT5 loads its calendar on    |
//| demand and times out (error 5401) on big or early requests, so    |
//| ask a month at a time and retry a timeout after a pause.          |
//| Returns the count, or -1 when the month couldn't be loaded.       |
//+------------------------------------------------------------------+
int LoadMonth(MqlCalendarValue &values[], const datetime from, const datetime to, const string currency)
  {
   for(int attempt = 1; attempt <= 6 && !IsStopped(); attempt++)
     {
      ResetLastError();
      int count = CalendarValueHistory(values, from, to, NULL, currency);
      int error = GetLastError();
      if(count > 0)
         return count;
      if(error == 0 || error == ERR_CALENDAR_NO_DATA)
         return 0;                                   // genuinely nothing that month
      if(error != ERR_CALENDAR_TIMEOUT)
        {
         PrintFormat("⚠ %s %s: error %d", currency, TimeToString(from, TIME_DATE), error);
         return -1;
        }
      Sleep(2000 * attempt);                         // calendar still downloading
     }
   PrintFormat("⚠ %s %s: calendar kept timing out", currency, TimeToString(from, TIME_DATE));
   return -1;
  }

//+------------------------------------------------------------------+
//| Script program start function                                    |
//+------------------------------------------------------------------+
void OnStart()
  {
   string currencies[];
   int currencyCount = StringSplit(InpCurrencies, ',', currencies);
   if(currencyCount <= 0)
     {
      Print("❌ No currencies given.");
      return;
     }

   int file = FileOpen(InpFile, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(file == INVALID_HANDLE)
     {
      Print("❌ Couldn't create ", InpFile, " | Error: ", GetLastError());
      return;
     }
   // Times are the broker's server time; TradeJournal works out the broker's clock on import.
   FileWriteString(file, "time,currency,importance,name,actual,forecast,previous\r\n");

   int written = 0, failedMonths = 0;
   datetime until = TimeTradeServer() + 14 * 86400;   // and the next two weeks' schedule
   for(int c = 0; c < currencyCount && !IsStopped(); c++)
     {
      string currency = currencies[c];
      StringTrimLeft(currency);
      StringTrimRight(currency);
      StringToUpper(currency);
      if(currency == "")
         continue;

      int kept = 0;
      MqlDateTime start;
      TimeToStruct(InpFrom, start);
      start.day = 1; start.hour = 0; start.min = 0; start.sec = 0;
      for(datetime monthFrom = StructToTime(start); monthFrom < until && !IsStopped(); )
        {
         MqlDateTime next;
         TimeToStruct(monthFrom, next);
         next.mon++;
         if(next.mon > 12) { next.mon = 1; next.year++; }
         datetime monthTo = StructToTime(next);

         MqlCalendarValue values[];
         int count = LoadMonth(values, monthFrom, monthTo, currency);
         if(count < 0)
            failedMonths++;
         for(int i = 0; i < count; i++)
           {
            MqlCalendarEvent event;
            if(!CalendarEventById(values[i].event_id, event))
               continue;
            if(event.importance != CALENDAR_IMPORTANCE_HIGH && event.importance != CALENDAR_IMPORTANCE_MODERATE)
               continue;

            string line = TimeToString(values[i].time, TIME_DATE | TIME_MINUTES) + ","
                          + currency + ","
                          + (event.importance == CALENDAR_IMPORTANCE_HIGH ? "HIGH" : "MODERATE") + ","
                          + CsvField(event.name) + ","
                          + (values[i].HasActualValue()   ? CsvField(FormatValue(values[i].GetActualValue(), event))   : "") + ","
                          + (values[i].HasForecastValue() ? CsvField(FormatValue(values[i].GetForecastValue(), event)) : "") + ","
                          + (values[i].HasPreviousValue() ? CsvField(FormatValue(values[i].GetPreviousValue(), event)) : "");
            FileWriteString(file, line + "\r\n");
            kept++;
           }
         monthFrom = monthTo;
        }
      written += kept;
      Print("📰 ", currency, ": ", kept, " high/medium events");
     }

   FileClose(file);
   if(written == 0)
     {
      FileDelete(InpFile);
      Print("❌ No events exported. Open the Calendar tab in the Toolbox (Ctrl+T), let it load, then run NewsExport again.");
      return;
     }
   Print("✅ Exported ", written, " events to ", TerminalInfoString(TERMINAL_DATA_PATH), "\\MQL5\\Files\\", InpFile);
   if(failedMonths > 0)
      Print("⚠ ", failedMonths, " currency-months couldn't be loaded (see above). Run it again to fill them in; importing twice never duplicates.");
   Print("   Upload it in TradeJournal: Backtest -> Indicators -> Import MT5 news history.");
  }
//+------------------------------------------------------------------+
