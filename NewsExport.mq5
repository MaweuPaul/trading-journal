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

   int written = 0;
   for(int c = 0; c < currencyCount; c++)
     {
      string currency = currencies[c];
      StringTrimLeft(currency);
      StringTrimRight(currency);
      StringToUpper(currency);
      if(currency == "")
         continue;

      MqlCalendarValue values[];
      int count = CalendarValueHistory(values, InpFrom, 0, NULL, currency);
      if(count <= 0)
        {
         Print("⚠ No calendar events for ", currency, " | Error: ", GetLastError());
         continue;
        }

      int kept = 0;
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
      written += kept;
      Print("📰 ", currency, ": ", kept, " high/medium events");
     }

   FileClose(file);
   Print("✅ Exported ", written, " events to ", TerminalInfoString(TERMINAL_DATA_PATH), "\\MQL5\\Files\\", InpFile);
   Print("   Upload it in TradeJournal: Backtest -> Indicators -> Import MT5 news history.");
  }
//+------------------------------------------------------------------+
