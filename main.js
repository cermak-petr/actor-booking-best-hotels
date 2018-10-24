const Apify = require('apify');
const request = require('request-promise');

/**
 * Gets attribute as text from a ElementHandle.
 * @param {ElementHandle} element - The element to get attribute from.
 * @param {string} attr - Name of the attribute to get.
 */
async function getAttribute(element, attr){
    try{
        const prop = await element.getProperty(attr);
        return (await prop.jsonValue()).trim();
    }
    catch(e){return null;}
}

/**
 * Adds links from a page to the RequestQueue.
 * @param {Page} page - Puppeteer Page object containing the link elements.
 * @param {RequestQueue} requestQueue - RequestQueue to add the requests to.
 * @param {string} selector - A selector representing the links.
 * @param {Function} condition - Function to check if the link is to be added.
 * @param {string} label - A label for the added requests.
 * @param {Function} urlMod - Function for modifying the URL.
 * @param {Function} keyMod - Function for generating uniqueKey from the link ElementHandle.
 */
async function enqueueLinks(page, requestQueue, selector, condition, label, urlMod, keyMod){
    const links = await page.$$(selector);
    for(const link of links){
        const href = await getAttribute(link, 'href');
        if(href && (!condition || await condition(link))){
            await requestQueue.addRequest(new Apify.Request({
            	userData: {label: label},
            	url: urlMod ? urlMod(href) : href,
            	uniqueKey: keyMod ? (await keyMod(link)) : href
            }));
        }
    }
}

/** Main function */
Apify.main(async () => {
    
    // Actor INPUT variable
    const input = await Apify.getValue('INPUT');
    
    // Check if all required input attributes are present.
    if(!input.search){
        throw new Error('Missing "search" attribute in INPUT!');
    }
    
    // Main request queue.
    const requestQueue = await Apify.openRequestQueue();
    
    // Create startURL based on provided INPUT.
    const query = encodeURIComponent(input.search);
    let startUrl = `https://www.booking.com/searchresults.html?dest_type=city;ss=${query}&order=bayesian_review_score`;
    if(input.checkIn && input.checkOut){
        const ci = input.checkIn.split(/-|\//);
        const co = input.checkOut.split(/-|\//);
        startUrl += `&checkin_year_month_monthday=${ci[2]}-${ci[0]}-${ci[1]}`;
        startUrl += `&checkout_year_month_monthday=${co[2]}-${co[0]}-${co[1]}`;
    }
    if(input.currency){
        startUrl += `&selected_currency=${input.currency.toUpperCase()}&changed_currency=1&top_currency=1`;
    }
    if(input.language){
        const lng = input.language.replace('_','-');
        startUrl += `&lang=${lng}`;
    }
    
    // Enqueue all pagination pages.
    startUrl += '&rows=20';
    console.log('startUrl: ' + startUrl);
    await requestQueue.addRequest(new Apify.Request({url: startUrl, userData: {label: 'start'}}));
    for(let i = 1; i <= 20; i++){
        await requestQueue.addRequest(new Apify.Request({
            url: startUrl + '&offset=' + 20*i, 
            userData: {label: 'page'}
        }));
    }
    
    // Temporary fix, make UI proxy input compatible
    if(input.proxyConfig && input.proxyConfig.apifyProxyGroups){
        for(let i = 0; i < input.proxyConfig.apifyProxyGroups.length; i++){
            const gSpl = input.proxyConfig.apifyProxyGroups[i].split('-');
            const nGroup = gSpl[gSpl.length - 1];
            input.proxyConfig.apifyProxyGroups[i] = nGroup;
        }
    }
    
    /** Creates new Puppeteer Browser instance. */
    const launchPuppeteer = async () => {
        return await Apify.launchPuppeteer(input.proxyConfig || {});
    };
    
    let retiring = false;
    
    /** Finds a browser instance with working proxy for Booking.com. */
    async function getWorkingBrowser(){
        for(let i = 0; i < 1000; i++){
            console.log('testing proxy...');
            const browser = await launchPuppeteer();
            const page = await browser.newPage();
            await page.goto(startUrl);
            const pageUrl = await page.url();
            if(pageUrl.indexOf('bayesian') > -1 || i === 999){
                console.log('valid proxy found');
                await page.close();
                retiring = false;
                return browser;
            }
            console.log('invalid proxy, retrying...');
            await browser.close();
            retiring = false;
        }
    }
    
    // Main crawler variable.
    const crawler = new Apify.PuppeteerCrawler({
        requestQueue,
        
        maxConcurrency: input.concurrency || 10,
        
        launchPuppeteerFunction: getWorkingBrowser,
        
        // Main page handling function.
        handlePageFunction: async ({ page, request, puppeteerPool }) => {
            
            /** 
             * Extracts data from a hotel list page.
             * @param {Number} minScore - Minimum score for a hotel to be listed.
             */
            const listPageFunction = (minScore) => new Promise((resolve, reject) => {
   
                const $ = jQuery;
   
                /** 
                 * Waits for a condition to be non-false.
                 * @param {Function} condition - The condition Function.
                 * @param {Function} callback - Callback to be executed when the waiting is done.
                 */
                function waitFor(condition, callback, i){
                    var val = condition();
                    if(val){callback(val);}
                    else if(i > 10){callback(null);}
                    else{setTimeout(function(){waitFor(condition, callback, i ? i+1 : 1);}, 500);}
                }
                
                /** Gets total number of listings. */
                var getHeaderNumber = function(){
                    var av = $('.availability_nr').text().trim().replace(/(\s|\.|,)+/g, '').match(/\d+/);
                    var h1 = $('.sr_header h1').text().replace(/(\s|\.|,)+/g, '').match(/\d+/);
                    var h2 = $('.sr_header h2').text().replace(/(\s|\.|,)+/g, '').match(/\d+/);
                    var h4 = $('#results_prev_next h4').text().replace(/(\s|\.|,)+/g, '').match(/\d+/);
                    var fd = $('#sr-filter-descr').text().replace(/(\s|\.|,)+/g, '').match(/(\d+)de/);
                    return av ? av[0] : (h1 ? h1[0] : (h2 ? h2[0] : (h4 ? h4[0] : (fd ? fd[1] : null))));
                }
                
                // Extract listing data.
                var result = [];
                var num = getHeaderNumber();
                var items = $('.sr_item');//$('.sr_item').eq(0).nextUntil('.sr_separator').addBack();
                console.log('items: ' + items.length);
                var started = 0;
                var finished = 0;
                
                // Iterate all items
                items.each(function(index, sr){
                    var jThis = $(this);
                    var n1 = jThis.find('.score_from_number_of_reviews').text().replace(/(\s|\.|,)+/g, '').match(/\d+/);
                    var n2 = jThis.find('.review-score-widget__subtext').text().replace(/(\s|\.|,)+/g, '').match(/\d+/);
                    var n3 = jThis.find('.bui-review-score__text').text().replace(/(\s|\.|,)+/g, '').match(/\d+/);
                    var nReviews = n1 || n2 || n3;
                    if(true){
                        ++started;
                        sr.scrollIntoView();
                        var getPrice = function(){
                            return $(sr).find(':not(strong).site_price, .totalPrice, strong.price');
                        }
                        
                        // When the price is ready, extract data.
                        waitFor(function(){return getPrice().length > 0;}, function(){
                            var occ = jThis.find('.sr_max_occupancy i').length;
                            var rl = jThis.find('.room_link').contents();
                            var prtxt = getPrice().eq(0).text().trim().replace(/\,|\s/g, '');
                            var pr = prtxt.match(/\d+/);
                            var pc = prtxt.match(/[^\d]+/);
                            var rat = $(sr).attr('data-score');
                            var found = num ? parseInt(num) : null;
                            var starAttr = jThis.find('i.star_track svg').attr('class');
                            var stars = starAttr ? starAttr.match(/\d/) : null;
                            var item = {
                                'url': window.location.origin + $('.hotel_name_link').attr('href'),
                                //'total': found,
                                'name': $(sr).find('.sr-hotel__name').text().trim(),
                                'rating': rat ? parseFloat(rat.replace(',', '.')) : null,
                                'reviews': nReviews ? parseInt(nReviews[0]) : null,
                                'stars': stars ? parseInt(stars[0]) : null,
                                'price': pr ? parseFloat(pr[0]) : null,
                                'currency': pc ? pc[0].trim() : null,
                                'roomType': rl.length > 0 ? rl[0].textContent.trim() : null,
                                'persons': occ ? occ : null
                            };
                            if(item.score && item.score >= minScore){result.push(item);}
                            if(++finished >= started){
                                resolve(result.sort((a, b) => a - b));
                            }
                        });
                    }
                    else{resolve([]);}
                });
            });
            
            /** 
             * Creates a function to make sure the URL contains all necessary attributes from INPUT.
             * @param {strins} s - The URL attribute separator (& or ;).
             */
            const fixUrl = s => href => {
                href = href.replace(/#([a-zA-Z_]+)/g, '');
                if(input.language && href.indexOf('lang') < 0){
                    const lng = input.language.replace('_','-');
                    if(href.indexOf(s)){
                        href.replace(s, `${s}lang=${lng}${s}`);
                    }
                    else{href += `${s}lang=${lng}`;}
                }
                if(input.currency && href.indexOf('currency') < 0){
                    href += `${s}selected_currency=${input.currency.toUpperCase()}${s}changed_currency=1${s}top_currency=1`;
                }
                return href;
            };
            
            console.log('open url: ' + await page.url());
            
            /** Extracts information about all rooms listed by the hotel. */
            const extractRooms = async () => {
                let roomType, bedText, features;
                const rooms = [];
                
                // Iterate all table rows.
                const rows = await page.$$('.hprt-table > tbody > tr:not(.hprt-cheapest-block-row)');
                for(const row of rows){
                    const roomRow = await row.$('.hprt-table-cell-roomtype');
                    if(roomRow){
                        roomType = await row.$('.hprt-roomtype-icon-link');
                        const bedType = await row.$('.hprt-roomtype-bed');
                        bedText = bedType ? await getAttribute(bedType, 'textContent') : null;
                        
                        // Iterate and parse all room facilities.
                        const facilities = roomRow ? await roomRow.$$('.hprt-facilities-facility') : null;
                        features = [];
                        if(facilities){
                            for(const f of facilities){
                                const fText = (await getAttribute(f, 'textContent')).replace('•', '').trim();
                                if(fText.indexOf('ft²') > -1){
                                    const num = parseInt(fText.split(' ')[0]);
                                    const nText = parseInt(num*0.092903) + ' m²';
                                    features.push(nText);
                                }
                                else{features.push(fText);}
                            }
                        }
                    }
                    
                    // Extract data for each room.
                    const occupancy = await row.$eval('.hprt-occupancy-occupancy-info', hprt => {
                        if(!hprt){return null;}
                        const occ1 = document.querySelector('.hprt-occupancy-occupancy-info .invisible_spoken');
                        const occ2 = document.querySelector('.hprt-occupancy-occupancy-info').getAttribute('data-title');
                        const occ3 = document.querySelector('.hprt-occupancy-occupancy-info').textContent;
                        return occ1 ? occ1.textContent : (occ2 || occ3);
                    });
                    const persons = occupancy ? occupancy.match(/\d+/) : null;
                    const priceE = await row.$('.hprt-price-price');
                    const prict = priceE ? await getAttribute(priceE, 'textContent') : null;
                    const priceT = priceE ? (await getAttribute(priceE, 'textContent')).replace(/\s|,/g, '').match(/(\d|\.)+/) : null;
                    const priceC = priceE ? (await getAttribute(priceE, 'textContent')).replace(/\s|,/g, '').match(/[^\d\.]+/) : null;
                    
                    const room = {available: true};
                    if(roomType){room.roomType = await getAttribute(roomType, 'textContent');}
                    if(bedText){room.bedType = bedText.replace(/\n+/g, ' ');}
                    if(persons){room.persons = parseInt(persons[0]);}
                    if(priceT && priceC){
                        room.price = parseFloat(priceT[0]);
                        room.currency = priceC[0];
                        room.features = features;
                    }
                    else{room.available = false;}
                    await rooms.push(room);
                }
                return rooms;
            };
            
            /** Tells the crawler to re-enqueue current page and destroy the browser. 
             *  Necessary if the page was open through a not working proxy. */
            const retireBrowser = async () => {
                //if(retiring){return;}
                retiring = true;
                //console.log('proxy invalid, re-enqueuing...');
                await puppeteerPool.retire(page.browser());
                await requestQueue.addRequest(new Apify.Request({
                    url: request.url,
                    userData: request.userData,
                    uniqueKey: Math.random() + ''
                }));
            };
            
            // Extract data from the hotel detail page
            if(request.userData.label === 'detail'){
                try{await page.waitForSelector('.hprt-occupancy-occupancy-info');}
                catch(e){}
                
                const ldElem = await page.$('script[type="application/ld+json"]');
                const ld = JSON.parse(await getAttribute(ldElem, 'textContent'));
                
                // Check if the page was open through working proxy.
                const pageUrl = await page.url();
                if(pageUrl.indexOf('label') < 0){
                    await retireBrowser();
                    return;
                }
                
                // Exit if core data is not present ot the rating is too low.
                if(!ld || !ld.aggregateRating || ld.aggregateRating.ratingValue <= (input.minScore || 8.4)){
                    return;
                }
                
                // Extract the data.
                const name = await page.$('#hp_hotel_name');
                const starIcon = await page.$('i.bk-icon-stars');
                const starTitle = await getAttribute(starIcon, 'title');
                const stars = starTitle ? starTitle.match(/\d/) : null;
                const rooms = await extractRooms();
                await Apify.pushData({
                    url: await page.url(),
                    name: await getAttribute(name, 'textContent'),
                    stars: stars ? stars[0] : null,
                    rating: ld.aggregateRating.ratingValue,
                    reviews: ld.aggregateRating.reviewCount,
                    rooms: rooms
                });
            }
            // Handle hotel list page.
            else{
                // Check if the page was open through working proxy.
                const pageUrl = await page.url();
                if(pageUrl.indexOf('bayesian') < 0){
                    await retireBrowser();
                    return;
                }
                
                // If simple output is enough, extract the data.
                if(input.simple){
                    console.log('extracting data...');
                    await Apify.utils.puppeteer.injectJQuery(page);
                    const result = await page.evaluate(listPageFunction, input.minScore || 8.4);
                    if(result.length > 0){await Apify.pushData(result);}
                }
                // If not, enqueue the detail pages to be extracted.
                else{
                    console.log('enqueuing detail pages...');
                    await enqueueLinks(page, requestQueue, '.hotel_name_link', null, 'detail', fixUrl('&'));
                }
            }
        },
        
        // Failed request handling
        handleFailedRequestFunction: async ({ request }) => {
            await Apify.pushData({
                url: request.url,
                succeeded: false,
                errors: request.errorMessages,
            })
        },
        
        // Function for ignoring all unnecessary requests.
        gotoFunction: async ({ page, request }) => {
        	await page.setRequestInterception(true);
            
            page.on('request', (request) => {
                const url = request.url();
                if (url.includes('.js')) request.abort();
                else if (url.includes('.png')) request.abort();
                else if (url.includes('.jpg')) request.abort();
                else if (url.includes('.gif')) request.abort();
                else if (url.includes('.css')) request.abort();
                else if (url.includes('static/fonts')) request.abort();
                else if (url.includes('js_tracking')) request.abort();
                else if (url.includes('facebook.com')) request.abort();
                else if (url.includes('googleapis.com')) request.abort();
                else if (url.includes('secure.booking.com')) request.abort();
                else if (url.includes('booking.com/logo')) request.abort();
                else if (url.includes('booking.com/navigation_times')) request.abort();
                else{request.continue();}
            });
        	
        	// Hide WebDriver and return new page.
        	await Apify.utils.puppeteer.hideWebDriver(page);
        	return await page.goto(request.url, {timeout: 200000});
        }
    });
    
    // Start the crawler.
    await crawler.run();
});
