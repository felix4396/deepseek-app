package com.example.deepseekchat;

import android.content.Intent;
import android.net.Uri;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.JSObject;

@CapacitorPlugin(name = "CardpayBrowser")
public class CardpayBrowserPlugin extends Plugin {
  @com.getcapacitor.PluginMethod
  public void open(PluginCall call) {
    String url = call.getString("url", "");
    if (!url.startsWith("https://")) { call.reject("Payment checkout requires a configured HTTPS gateway"); return; }
    try { getContext().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); call.resolve(new JSObject()); }
    catch (Exception error) { call.reject("No system browser available", error); }
  }
}
