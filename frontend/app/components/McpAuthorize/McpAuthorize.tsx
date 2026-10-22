import Logo from '@/layout/Logo';
import { Button, Card, Input } from 'antd';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';

import { client, useStore } from 'App/mstore';
import { sessions, withSiteId } from 'App/routes';
import { useLocation, useNavigate } from 'App/routing';

function McpAuthorize() {
  const { t } = useTranslation();
  const { userStore, loginStore, projectsStore } = useStore();
  const accountName = userStore.account.name;
  const location = useLocation();
  const navigate = useNavigate();
  const [authorized, setAuthorized] = React.useState(false);
  const [userCode, setUserCode] = React.useState('');

  const searchParams = new URLSearchParams(location.search);
  const state = searchParams.get('state');
  const clientId = searchParams.get('client_id');
  const codeChallenge = searchParams.get('code_challenge');

  const openRoot = () => {
    navigate(withSiteId(sessions(), projectsStore.activeSiteId));
  };
  const handleAuthorize = async () => {
    try {
      const response = await client.post('/v1/mcp/authorize', {
        state,
        clientId,
        userCode,
        codeChallenge,
      });
      const data = await response.json();
      if (data?.data?.success) {
        setAuthorized(true);
      } else if (data?.errors?.length) {
        toast.error(data.errors[0]);
      }
    } catch (e: any) {
      toast.error(e.message || 'Something went wrong');
    }
  };

  const handleLogout = () => {
    loginStore.invalidateSpotJWT();
    window.postMessage({ type: 'orspot:invalidate' }, '*');
    void userStore.logout();
  };

  return (
    <div className="flex items-center justify-center bg-gray-lightest fixed top-0 bottom-0 left-0 right-0">
      <Card style={{ width: 400 }}>
        <div className="flex flex-col items-center gap-4">
          <Logo siteId={projectsStore.activeSiteId} />
          {authorized ? (
            <div className="flex flex-col items-center gap-4">
              <div className="text-center">
                {t('Authorization successful. You can close this page now.')}
              </div>
              <div className="link" onClick={openRoot}>
                {t('Back to Openreplay')}
              </div>
            </div>
          ) : (
            <>
              <div className="text-center">
                <div>
                  {t(
                    'Openreplay MCP Application would like to connect to your account',
                  )}
                </div>
                <div className="font-semibold mt-1">{accountName}</div>
              </div>
              {codeChallenge ? (
                <div className="flex flex-col gap-2 w-full">
                  <div className="text-sm">
                    {t(
                      'Enter the confirmation code shown by your MCP client. Only continue if you started this sign-in yourself, and never enter a code that someone sent you.',
                    )}
                  </div>
                  <Input
                    value={userCode}
                    onChange={(e) => setUserCode(e.target.value)}
                    placeholder="XXXX-XXXX"
                    autoComplete="off"
                    maxLength={16}
                  />
                </div>
              ) : (
                <div className="text-sm color-red">
                  {t(
                    'This authorization link is missing its confirmation code. Update your OpenReplay MCP client and start the sign-in again.',
                  )}
                </div>
              )}
              <div className="flex flex-col items-center gap-2 w-full mt-2">
                <Button
                  type="primary"
                  block
                  onClick={handleAuthorize}
                  disabled={!codeChallenge || userCode.trim().length < 8}
                >
                  {t('Authorize')}
                </Button>
                <Button block onClick={handleLogout}>
                  {t('Logout')}
                </Button>
                <div className="link mt-2" onClick={openRoot}>
                  {t('Back to Openreplay')}
                </div>
              </div>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}

export default McpAuthorize;
