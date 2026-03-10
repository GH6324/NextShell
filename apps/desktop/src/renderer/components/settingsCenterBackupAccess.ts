interface PasswordStatus {
  isSet: boolean;
  isUnlocked: boolean;
  keytarAvailable: boolean;
}

interface BackupSectionAccessInput {
  pwdStatusKnown: boolean;
  pwdStatus: PasswordStatus;
}

interface BackupSectionAccess {
  showSetPasswordAlert: boolean;
  showUnlockPasswordAlert: boolean;
  showProtectedContent: boolean;
}

export const resolveBackupSectionAccess = ({
  pwdStatusKnown,
  pwdStatus
}: BackupSectionAccessInput): BackupSectionAccess => {
  if (!pwdStatusKnown) {
    return {
      showSetPasswordAlert: false,
      showUnlockPasswordAlert: false,
      showProtectedContent: true
    };
  }

  return {
    showSetPasswordAlert: !pwdStatus.isSet,
    showUnlockPasswordAlert: pwdStatus.isSet && !pwdStatus.isUnlocked,
    showProtectedContent: pwdStatus.isUnlocked
  };
};
