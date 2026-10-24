//! Windows Hello for locked groups (`UserConsentVerifier`, read-only: nothing is registered or
//! stored; the prompt belongs to Windows). Blocking: call from a worker thread.

use windows::core::{factory, HSTRING};
use windows::Security::Credentials::UI::{
    UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
};
use windows::Win32::System::WinRT::IUserConsentVerifierInterop;
use windows_future::IAsyncOperation;

use crate::desktop_window;

/// Windows Hello (face, fingerprint or Hello PIN) is set up for this user.
pub fn available() -> bool {
    UserConsentVerifier::CheckAvailabilityAsync()
        .and_then(|op| op.join())
        .map(|a| a == UserConsentVerifierAvailability::Available)
        .unwrap_or(false)
}

/// Shows Windows' own Hello prompt over the desktop window; true when the user was verified.
pub fn verify(message: String) -> Result<bool, String> {
    let hwnd = desktop_window::desktop_hwnd();
    let message = HSTRING::from(message);
    let op: IAsyncOperation<UserConsentVerificationResult> = if hwnd.is_invalid() {
        UserConsentVerifier::RequestVerificationAsync(&message).map_err(|e| e.to_string())?
    } else {
        let interop = factory::<UserConsentVerifier, IUserConsentVerifierInterop>().map_err(|e| e.to_string())?;
        unsafe { interop.RequestVerificationForWindowAsync(hwnd, &message) }.map_err(|e| e.to_string())?
    };
    let result = op.join().map_err(|e| e.to_string())?;
    Ok(result == UserConsentVerificationResult::Verified)
}
