package com.example.deepseekchat;

import android.content.Intent;
import android.net.Uri;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 用系统浏览器（ACTION_VIEW）打开收银台。
 *
 * 只放行 https：支付页必须是加密连接，明文地址既不安全也可能被中间人替换。
 * 插件本身不校验业务参数、不拼 URL —— 收银台地址一律由服务端下发。
 */
@CapacitorPlugin(name = "CheckoutBrowser")
public class CheckoutBrowserPlugin extends Plugin {

  @PluginMethod
  public void open(PluginCall call) {
    String url = call.getString("url", "");
    if (url == null || !url.startsWith("https://")) {
      call.reject("checkout-url-must-be-https");
      return;
    }
    try {
      Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      getContext().startActivity(intent);
      JSObject result = new JSObject();
      result.put("opened", true);
      call.resolve(result);
    } catch (Exception error) {
      call.reject("no-browser-available", error);
    }
  }

  /**
   * 只取 302 的 Location（不跟随、不把正文交给 JS）。
   *
   * 为什么需要它：/buy 是 GET + 302，App 必须拿到 Location（收银台地址 + 单号 + order_token）
   * 才能用系统浏览器打开并查单。CapacitorHttp 的 disableRedirects 会带回 location 头，
   * 但若某台设备上没带，这条原生兜底能再取一次，避免整个购买流程失效。
   *
   * 只接受 http(s)：明文地址不会因此变成允许的收银台（JS 层还要求 https 才打开）。
   */
  @PluginMethod
  public void resolveLocation(PluginCall call) {
    final String url = call.getString("url", "");
    if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) {
      call.reject("invalid-url");
      return;
    }
    new Thread(
        () -> {
          HttpURLConnection connection = null;
          try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setRequestMethod("GET");
            // 关键：不跟随重定向，只读 Location
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(10000);
            connection.setRequestProperty("Accept", "text/html");
            int status = connection.getResponseCode();
            String location = connection.getHeaderField("Location");
            JSObject result = new JSObject();
            result.put("status", status);
            result.put("location", location == null ? "" : location);
            call.resolve(result);
          } catch (Exception error) {
            call.reject("location-unavailable", error);
          } finally {
            if (connection != null) {
              connection.disconnect();
            }
          }
        })
        .start();
  }
}
