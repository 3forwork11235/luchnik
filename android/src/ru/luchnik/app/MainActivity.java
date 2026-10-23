package ru.luchnik.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Rect;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.MimeTypeMap;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

// Обёртка «Лучника»: игра (index.html + room.js) лежит внутри APK в assets.
// Приложение отдаёт эти файлы по адресу https://appassets.androidplatform.net/ — для страницы это
// обычный защищённый сайт, поэтому работают localStorage, WebRTC (P2P) и запасной канал MQTT.
public class MainActivity extends Activity {
    static final String HOST = "appassets.androidplatform.net";
    static final String START = "https://" + HOST + "/index.html";

    WebView web;
    long backAt;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 28)
            getWindow().getAttributes().layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;

        web = new WebView(this);
        web.setBackgroundColor(0xFF121725);
        // удержание пальца при натяжении лука — не «долгое нажатие» системы (выделение, вибрация, меню)
        web.setOnLongClickListener(v -> true);
        web.setLongClickable(false);
        web.setHapticFeedbackEnabled(false);
        // жест «назад» от края экрана не должен перехватывать натяжение: лучники стоят внизу у краёв
        if (Build.VERSION.SDK_INT >= 29)
            web.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> {
                int w = r - l, h = b - t, lim = (int) (200 * getResources().getDisplayMetrics().density);
                List<Rect> rects = new ArrayList<>();
                rects.add(new Rect(0, Math.max(0, h - lim), w / 2, h));
                rects.add(new Rect(w / 2, Math.max(0, h - lim), w, h));
                v.setSystemGestureExclusionRects(rects);
            });
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setTextZoom(100); // крупный шрифт в настройках телефона не должен ломать вёрстку игры
        // ws:// к server.py в локальной сети — со страницы https это «смешанное содержимое»
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        // по этой метке игра понимает, что запущена в приложении
        String ver = "1";
        try { ver = getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { }
        s.setUserAgentString(s.getUserAgentString() + " LuchnikApp/" + ver);

        web.setWebChromeClient(new WebChromeClient()); // alert/confirm игры
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                return HOST.equals(u.getHost()) ? asset(u.getPath()) : null;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (HOST.equals(u.getHost())) return false;
                // внешние ссылки — в браузер телефона
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception e) { }
                return true;
            }
        });

        // восстановление может не удаться (пустая история) — тогда просто открываем игру заново
        if (saved == null || web.restoreState(saved) == null) web.loadUrl(START);
    }

    static final Map<String, String> TYPES = new HashMap<>();
    static {
        TYPES.put("html", "text/html");
        TYPES.put("js", "text/javascript");
        TYPES.put("json", "application/json");
        TYPES.put("webmanifest", "application/manifest+json");
        TYPES.put("css", "text/css");
        TYPES.put("png", "image/png");
        TYPES.put("svg", "image/svg+xml");
    }

    WebResourceResponse asset(String path) {
        if (path == null || path.equals("/") || path.isEmpty()) path = "/index.html";
        path = path.substring(1);
        String ext = path.substring(path.lastIndexOf('.') + 1).toLowerCase();
        String type = TYPES.get(ext);
        if (type == null) type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        if (type == null) type = "application/octet-stream";
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", "no-cache");
        h.put("Access-Control-Allow-Origin", "*");
        try {
            InputStream in = getAssets().open(path);
            return new WebResourceResponse(type, type.startsWith("image") ? null : "utf-8", 200, "OK", h, in);
        } catch (IOException e) {
            // настоящий 404: иначе запрос ушёл бы в сеть на несуществующий адрес
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", h, new ByteArrayInputStream(new byte[0]));
        }
    }

    void immersive() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    @Override
    public void onWindowFocusChanged(boolean focus) {
        super.onWindowFocusChanged(focus);
        if (focus) immersive();
    }

    @Override
    protected void onPause() {
        super.onPause();
        web.onPause(); // как свёрнутый браузер: игра видит document.hidden и потом сама переподключается
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        long now = System.currentTimeMillis();
        if (now - backAt < 2000) { super.onBackPressed(); return; }
        backAt = now;
        Toast.makeText(this, "Нажмите «назад» ещё раз, чтобы выйти", Toast.LENGTH_SHORT).show();
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }
}
