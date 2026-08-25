$ErrorActionPreference = 'Stop'
$title = $env:MCP_NOTIFY_TITLE
$message = $env:MCP_NOTIFY_MESSAGE
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  $escapedTitle = [System.Security.SecurityElement]::Escape($title)
  $escapedMessage = [System.Security.SecurityElement]::Escape($message)
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$escapedTitle</text><text>$escapedMessage</text></binding></visual></toast>")
  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('PowerShell').Show($toast)
} catch {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $notification = New-Object System.Windows.Forms.NotifyIcon
  $notification.Icon = [System.Drawing.SystemIcons]::Information
  $notification.BalloonTipTitle = $title
  $notification.BalloonTipText = $message
  $notification.Visible = $true
  $notification.ShowBalloonTip(5000)
  Start-Sleep -Milliseconds 5500
  $notification.Dispose()
}
