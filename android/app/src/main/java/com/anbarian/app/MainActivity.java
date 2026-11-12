package com.anbarian.app;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(SaveFilePlugin.class);
        registerPlugin(ShareFilePlugin.class);
        registerPlugin(AutoBackupPlugin.class);
        registerPlugin(DriveBackupPlugin.class);
        registerPlugin(BiometricPlugin.class);
        registerPlugin(NativePrintPlugin.class);
        registerPlugin(DueNotificationsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
