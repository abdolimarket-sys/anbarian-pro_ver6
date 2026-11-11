package com.anbarian.app;

import android.accounts.Account;
import android.content.Intent;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.GoogleAuthUtil;
import com.google.android.gms.auth.api.signin.GoogleSignIn;
import com.google.android.gms.auth.api.signin.GoogleSignInAccount;
import com.google.android.gms.auth.api.signin.GoogleSignInClient;
import com.google.android.gms.auth.api.signin.GoogleSignInOptions;
import com.google.android.gms.auth.api.signin.GoogleSignInStatusCodes;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.Scope;
import com.google.android.gms.tasks.Task;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * پشتیبان خودکار Google Drive بدون انتخاب دستی پوشه.
 * یک‌بار ورود با حساب گوگل؛ پوشه AnbarinBackups توسط خود اپ ساخته می‌شود.
 * اسکوپ: drive.file (فقط فایل‌های ساخته‌شده توسط همین اپ)
 */
@CapacitorPlugin(name = "DriveBackup")
public class DriveBackupPlugin extends Plugin {
    private static final String FOLDER_NAME = "AnbarinBackups";
    private static final String SCOPE = "oauth2:https://www.googleapis.com/auth/drive.file";
    private static final Scope DRIVE_SCOPE = new Scope("https://www.googleapis.com/auth/drive.file");
    private static final String PREFS = "anbarin_drive_backup";
    private static final String KEY_FOLDER = "folder_id";

    private GoogleSignInClient signInClient() {
        GoogleSignInOptions gso = new GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
            .requestEmail()
            .requestScopes(DRIVE_SCOPE)
            .build();
        return GoogleSignIn.getClient(getContext(), gso);
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        GoogleSignInAccount account = GoogleSignIn.getLastSignedInAccount(getContext());
        JSObject res = new JSObject();
        boolean connected = account != null && GoogleSignIn.hasPermissions(account, DRIVE_SCOPE);
        res.put("connected", connected);
        res.put("email", account != null && account.getEmail() != null ? account.getEmail() : "");
        res.put("folderId", prefs().getString(KEY_FOLDER, ""));
        call.resolve(res);
    }

    @PluginMethod
    public void connect(PluginCall call) {
        GoogleSignInAccount existing = GoogleSignIn.getLastSignedInAccount(getContext());
        if (existing != null && GoogleSignIn.hasPermissions(existing, DRIVE_SCOPE)) {
            JSObject res = new JSObject();
            res.put("connected", true);
            res.put("email", existing.getEmail() != null ? existing.getEmail() : "");
            call.resolve(res);
            return;
        }
        Intent intent = signInClient().getSignInIntent();
        startActivityForResult(call, intent, "handleSignIn");
    }

    @ActivityCallback
    private void handleSignIn(PluginCall call, androidx.activity.result.ActivityResult result) {
        if (call == null) return;
        try {
            Task<GoogleSignInAccount> task = GoogleSignIn.getSignedInAccountFromIntent(result.getData());
            GoogleSignInAccount account = task.getResult(ApiException.class);
            if (account == null) {
                call.reject("ورود گوگل ناموفق بود");
                return;
            }
            JSObject res = new JSObject();
            res.put("connected", true);
            res.put("email", account.getEmail() != null ? account.getEmail() : "");
            call.resolve(res);
        } catch (ApiException e) {
            if (e.getStatusCode() == GoogleSignInStatusCodes.SIGN_IN_CANCELLED) {
                JSObject res = new JSObject();
                res.put("cancelled", true);
                res.put("connected", false);
                call.resolve(res);
                return;
            }
            // کد ۱۰ = DEVELOPER_ERROR (SHA-1/OAuth ثبت نشده) → کلاینت می‌تواند به انتخاب پوشه Drive برگردد
            JSObject res = new JSObject();
            res.put("connected", false);
            res.put("cancelled", false);
            res.put("errorCode", e.getStatusCode());
            res.put("needsFolderFallback", true); // اگر OAuth کامل نباشد، کلاینت پوشه Drive را یک‌بار می‌گیرد
            res.put("message", "ورود گوگل ناموفق: " + e.getStatusCode());
            call.resolve(res);
        } catch (Exception e) {
            JSObject res = new JSObject();
            res.put("connected", false);
            res.put("needsFolderFallback", true);
            res.put("message", e.getMessage() != null ? e.getMessage() : "خطای ورود");
            call.resolve(res);
        }
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        prefs().edit().remove(KEY_FOLDER).apply();
        signInClient().signOut().addOnCompleteListener(task -> {
            JSObject res = new JSObject();
            res.put("connected", false);
            call.resolve(res);
        });
    }

    @PluginMethod
    public void write(PluginCall call) {
        String filename = call.getString("filename", "anbarin-auto.json");
        String base64 = call.getString("data", "");
        if (base64 == null || base64.isEmpty()) {
            call.reject("محتوای پشتیبان خالی است");
            return;
        }
        GoogleSignInAccount account = GoogleSignIn.getLastSignedInAccount(getContext());
        if (account == null || account.getAccount() == null) {
            call.reject("ابتدا به Google Drive وصل شوید");
            return;
        }
        final Account acc = account.getAccount();
        final String safe = filename.replaceAll("[\\\\/:*?\"<>|]", "_");
        final byte[] bytes = Base64.decode(base64, Base64.DEFAULT);

        new Thread(() -> {
            try {
                String token = GoogleAuthUtil.getToken(getContext(), acc, SCOPE);
                String folderId = ensureFolder(token);
                String fileId = findFileInFolder(token, folderId, safe);
                if (fileId != null) {
                    updateFile(token, fileId, bytes);
                } else {
                    createFile(token, folderId, safe, bytes);
                }
                JSObject res = new JSObject();
                res.put("ok", true);
                res.put("filename", safe);
                res.put("folderId", folderId);
                getBridge().getActivity().runOnUiThread(() -> call.resolve(res));
            } catch (Exception e) {
                getBridge().getActivity().runOnUiThread(() ->
                    call.reject("آپلود به Drive ناموفق: " + e.getMessage(), e));
            }
        }).start();
    }

    @PluginMethod
    public void list(PluginCall call) {
        GoogleSignInAccount account = GoogleSignIn.getLastSignedInAccount(getContext());
        if (account == null || account.getAccount() == null) {
            JSObject res = new JSObject();
            res.put("files", new JSArray());
            call.resolve(res);
            return;
        }
        final Account acc = account.getAccount();
        new Thread(() -> {
            try {
                String token = GoogleAuthUtil.getToken(getContext(), acc, SCOPE);
                String folderId = ensureFolder(token);
                JSONArray files = listFilesInFolder(token, folderId);
                JSArray out = new JSArray();
                for (int i = 0; i < files.length(); i++) {
                    JSONObject f = files.getJSONObject(i);
                    JSObject item = new JSObject();
                    item.put("name", f.optString("name"));
                    item.put("id", f.optString("id"));
                    item.put("modified", f.optString("modifiedTime"));
                    out.put(item);
                }
                JSObject res = new JSObject();
                res.put("files", out);
                res.put("folderId", folderId);
                getBridge().getActivity().runOnUiThread(() -> call.resolve(res));
            } catch (Exception e) {
                getBridge().getActivity().runOnUiThread(() ->
                    call.reject("فهرست Drive ناموفق: " + e.getMessage(), e));
            }
        }).start();
    }

    @PluginMethod
    public void read(PluginCall call) {
        String fileId = call.getString("id", "");
        String name = call.getString("name", "");
        GoogleSignInAccount account = GoogleSignIn.getLastSignedInAccount(getContext());
        if (account == null || account.getAccount() == null) {
            call.reject("به Drive وصل نیستید");
            return;
        }
        final Account acc = account.getAccount();
        new Thread(() -> {
            try {
                String token = GoogleAuthUtil.getToken(getContext(), acc, SCOPE);
                String id = fileId;
                if ((id == null || id.isEmpty()) && name != null && !name.isEmpty()) {
                    String folderId = ensureFolder(token);
                    id = findFileInFolder(token, folderId, name);
                }
                if (id == null || id.isEmpty()) {
                    getBridge().getActivity().runOnUiThread(() -> call.reject("فایل در Drive پیدا نشد"));
                    return;
                }
                byte[] bytes = downloadFile(token, id);
                JSObject res = new JSObject();
                res.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
                res.put("id", id);
                res.put("name", name != null ? name : "");
                getBridge().getActivity().runOnUiThread(() -> call.resolve(res));
            } catch (Exception e) {
                getBridge().getActivity().runOnUiThread(() ->
                    call.reject("خواندن از Drive ناموفق: " + e.getMessage(), e));
            }
        }).start();
    }

    private android.content.SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE);
    }

    private String ensureFolder(String token) throws Exception {
        String cached = prefs().getString(KEY_FOLDER, "");
        if (cached != null && !cached.isEmpty()) {
            // اعتبارسنجی سریع
            if (folderExists(token, cached)) return cached;
        }
        String existing = findFolder(token, FOLDER_NAME);
        if (existing != null) {
            prefs().edit().putString(KEY_FOLDER, existing).apply();
            return existing;
        }
        String created = createFolder(token, FOLDER_NAME);
        prefs().edit().putString(KEY_FOLDER, created).apply();
        return created;
    }

    private boolean folderExists(String token, String id) {
        try {
            HttpURLConnection c = open("https://www.googleapis.com/drive/v3/files/" + id + "?fields=id,mimeType,trashed", token, "GET");
            int code = c.getResponseCode();
            if (code != 200) return false;
            JSONObject o = new JSONObject(readBody(c));
            return !o.optBoolean("trashed", false)
                && "application/vnd.google-apps.folder".equals(o.optString("mimeType"));
        } catch (Exception e) {
            return false;
        }
    }

    private String findFolder(String token, String name) throws Exception {
        String q = "mimeType='application/vnd.google-apps.folder' and name='" + escapeQuery(name) + "' and trashed=false";
        String url = "https://www.googleapis.com/drive/v3/files?pageSize=5&spaces=drive&fields=files(id,name)&q="
            + URLEncoder.encode(q, "UTF-8");
        HttpURLConnection c = open(url, token, "GET");
        if (c.getResponseCode() != 200) throw new Exception("جستجوی پوشه: HTTP " + c.getResponseCode());
        JSONObject o = new JSONObject(readBody(c));
        JSONArray files = o.optJSONArray("files");
        if (files != null && files.length() > 0) return files.getJSONObject(0).getString("id");
        return null;
    }

    private String createFolder(String token, String name) throws Exception {
        JSONObject meta = new JSONObject();
        meta.put("name", name);
        meta.put("mimeType", "application/vnd.google-apps.folder");
        byte[] body = meta.toString().getBytes(StandardCharsets.UTF_8);
        HttpURLConnection c = open("https://www.googleapis.com/drive/v3/files?fields=id", token, "POST");
        c.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
        c.setDoOutput(true);
        try (OutputStream out = c.getOutputStream()) { out.write(body); }
        if (c.getResponseCode() != 200 && c.getResponseCode() != 201) {
            throw new Exception("ساخت پوشه: HTTP " + c.getResponseCode() + " " + readError(c));
        }
        return new JSONObject(readBody(c)).getString("id");
    }

    private String findFileInFolder(String token, String folderId, String name) throws Exception {
        String q = "name='" + escapeQuery(name) + "' and '" + folderId + "' in parents and trashed=false";
        String url = "https://www.googleapis.com/drive/v3/files?pageSize=5&fields=files(id,name)&q="
            + URLEncoder.encode(q, "UTF-8");
        HttpURLConnection c = open(url, token, "GET");
        if (c.getResponseCode() != 200) return null;
        JSONArray files = new JSONObject(readBody(c)).optJSONArray("files");
        if (files != null && files.length() > 0) return files.getJSONObject(0).getString("id");
        return null;
    }

    private JSONArray listFilesInFolder(String token, String folderId) throws Exception {
        String q = "'" + folderId + "' in parents and trashed=false";
        String url = "https://www.googleapis.com/drive/v3/files?pageSize=20&orderBy=modifiedTime desc&fields=files(id,name,modifiedTime)&q="
            + URLEncoder.encode(q, "UTF-8");
        HttpURLConnection c = open(url, token, "GET");
        if (c.getResponseCode() != 200) throw new Exception("list HTTP " + c.getResponseCode());
        JSONArray files = new JSONObject(readBody(c)).optJSONArray("files");
        return files != null ? files : new JSONArray();
    }

    private void createFile(String token, String folderId, String name, byte[] content) throws Exception {
        JSONObject meta = new JSONObject();
        meta.put("name", name);
        meta.put("parents", new JSONArray().put(folderId));
        byte[] metaBody = meta.toString().getBytes(StandardCharsets.UTF_8);
        HttpURLConnection c = open("https://www.googleapis.com/drive/v3/files?fields=id", token, "POST");
        c.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
        c.setDoOutput(true);
        try (OutputStream out = c.getOutputStream()) { out.write(metaBody); }
        if (c.getResponseCode() != 200 && c.getResponseCode() != 201) {
            throw new Exception("ساخت فایل: HTTP " + c.getResponseCode() + " " + readError(c));
        }
        String fileId = new JSONObject(readBody(c)).getString("id");
        updateFile(token, fileId, content);
    }

    private void updateFile(String token, String fileId, byte[] content) throws Exception {
        // بعضی نسخه‌های HttpURLConnection متد PATCH را مستقیم نمی‌پذیرند
        HttpURLConnection c = open("https://www.googleapis.com/upload/drive/v3/files/" + fileId + "?uploadType=media", token, "POST");
        c.setRequestProperty("X-HTTP-Method-Override", "PATCH");
        c.setRequestProperty("Content-Type", "application/json");
        c.setDoOutput(true);
        try {
            c.getClass().getMethod("setRequestMethod", String.class).invoke(c, "PATCH");
        } catch (Exception ignored) {
            // اگر PATCH ممکن نبود همان POST+Override
        }
        try (OutputStream out = c.getOutputStream()) { out.write(content); }
        if (c.getResponseCode() != 200) {
            throw new Exception("به‌روزرسانی فایل: HTTP " + c.getResponseCode() + " " + readError(c));
        }
    }

    private byte[] downloadFile(String token, String fileId) throws Exception {
        HttpURLConnection c = open("https://www.googleapis.com/drive/v3/files/" + fileId + "?alt=media", token, "GET");
        if (c.getResponseCode() != 200) throw new Exception("دانلود HTTP " + c.getResponseCode());
        InputStream in = c.getInputStream();
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) != -1) bos.write(buf, 0, n);
        in.close();
        return bos.toByteArray();
    }

    private HttpURLConnection open(String url, String token, String method) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod(method);
        c.setRequestProperty("Authorization", "Bearer " + token);
        c.setConnectTimeout(30000);
        c.setReadTimeout(60000);
        return c;
    }

    private static String readBody(HttpURLConnection c) throws Exception {
        InputStream in = c.getInputStream();
        BufferedReader br = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder();
        String line;
        while ((line = br.readLine()) != null) sb.append(line);
        br.close();
        return sb.toString();
    }

    private static String readError(HttpURLConnection c) {
        try {
            InputStream in = c.getErrorStream();
            if (in == null) return "";
            BufferedReader br = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = br.readLine()) != null) sb.append(line);
            br.close();
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    private static String escapeQuery(String s) {
        return s.replace("\\", "\\\\").replace("'", "\\'");
    }
}
